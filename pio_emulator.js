// Emulator for one PIO state machine.
//
// Behaviour follows the PIO chapters of the RP2040 and RP2350 datasheets.
// Section numbers in comments refer to the RP2350 datasheet unless noted.
// Configuration defaults are the hardware register reset values.
class PioEmulator {
    constructor() {
        this.instructions = [];
        this.wrapTarget = 0;
        this.wrap = 0;
        this.sidesetCount = 0;      // side-set data bits (.side_set count)
        this.sidesetOpt = false;
        this.sidesetPindirs = false;
        this.pioVersion = 1;        // 0 = RP2040, 1 = RP2350
        // Input waveforms from `; #pragma pio_sim pin ...` (owned by loadProgram).
        this.stimuli = [];
        // IRQ flag events from `; #pragma pio_sim irq ...` (owned by loadProgram).
        this.irqEvents = [];
        // INPUT_SYNC_BYPASS resets to 0: every input passes through the
        // 2-flipflop synchroniser. 1 = bypassed for that GPIO.
        this.inputSyncBypass = 0;
        this.reset();
    }

    reset() {
        this.pc = 0;
        this.x = 0;
        this.y = 0;
        this.osr = 0;
        this.isr = 0;
        this.osrCount = 32; // bits shifted out; starts "empty" (§11.2.4.2)
        this.isrCount = 0;

        this.txFifo = [];
        this.rxFifo = [];
        // RX FIFO storage, used as four registers in the put/get FIFO modes.
        this.rxRegs = [0, 0, 0, 0];

        this.clock = 0;     // state machine cycles since reset
        this.delay = 0;
        // Clock divider (CLKDIV, 16.8 fixed point; resets to 1). The state
        // machine runs on one system clock in `clkDiv`; `sysclk` is the
        // system clock of the current cycle. The input path is clocked by
        // the system clock, so input latency in state machine cycles
        // shrinks as the divider grows (measured on RP2040 and RP2350).
        this.clkDiv = 1;
        this.sysclk = 0;
        this.clkDivAcc = 0;
        this.clkDivCarry = false;
        // Pad levels of the last few cycles, for the input path.
        this.padRecords = [];
        // Instruction latched by OUT EXEC / MOV EXEC, run on the next cycle.
        this.execLatch = null;

        this.pins = 0;      // output level register
        this.pindirs = 0;   // output enable register: 1 = out, 0 = in
        this.inputs = 0;    // levels driven onto the pads from outside
        // Input path: pad -> [FF1 -> FF2 unless bypassed] -> input register
        // -> state machine. `inputsSeen` is what the state machine reads.
        this.inputsFf1 = 0;
        this.inputsFf2 = 0;
        this.inputsSeen = 0;

        this.outBase = 0;
        this.outCount = 0;  // PINCTRL_OUT_COUNT resets to 0
        this.setBase = 0;
        this.setCount = 5;  // PINCTRL_SET_COUNT resets to 5
        this.sidesetBase = 0;
        this.inBase = 0;
        this.inCount = 32;  // SHIFTCTRL_IN_COUNT (RP2350); 32 = no masking
        this.jmpPin = 0;

        this.inShiftDir = 'right';
        this.outShiftDir = 'right';
        this.autoPush = false;
        this.autoPull = false;
        this.pushThresh = 32;
        this.pullThresh = 32;
        this.statusSel = 0; // 0 = TX FIFO level, 1 = RX FIFO level, 2 = IRQ flag (RP2350)
        this.statusN = 0;
        // txrx | tx | rx | txput | txget | putget (SHIFTCTRL_FJOIN_*)
        this.fifoMode = 'txrx';

        // instructions, wrap, side-set layout and stimuli are owned by
        // loadProgram — do not reset here.

        this.history = [];
        this.irq = 0;
        this.irqPrev = 0;
        this.irqNext = 0;
        this.irqWaitStalled = false; // sticky while an IRQ wait is stalling
        this.irqWaitPc = -1;
        this.status = 'stopped';
        this.error = null;

        this.applyStimuli();
        this.applyIrqEvents();
    }

    loadProgram(programData) {
        this.instructions = programData.instructions;
        this.wrapTarget = programData.wrapTarget;
        this.wrap = programData.wrap;
        this.sidesetCount = programData.sidesetCount || 0;
        this.sidesetOpt = programData.sidesetOpt || false;
        this.sidesetPindirs = programData.sidesetPindirs || false;
        this.pioVersion = programData.pioVersion === undefined ? 1 : programData.pioVersion;
        this.stimuli = programData.stimuli || [];
        this.irqEvents = programData.irqEvents || [];
        this.reset();
    }

    // ---- stimulus --------------------------------------------------------

    // Level a stimulus drives on its pin during PIO clock `clock`.
    stimulusLevel(stim, clock) {
        if (clock < stim.delay) return stim.delayLevel;
        let t = clock - stim.delay;
        if (stim.count !== null && t >= stim.period * stim.count) {
            return stim.segments[stim.segments.length - 1].level;
        }
        t %= stim.period;
        for (const seg of stim.segments) {
            if (t < seg.clocks) return seg.level;
            t -= seg.clocks;
        }
        return 0;
    }

    // Drive the stimulated input pins with their level for the current clock.
    applyStimuli() {
        for (const stim of this.stimuli) {
            if (this.stimulusLevel(stim, this.clock)) {
                this.inputs |= (1 << stim.pin);
            } else {
                this.inputs &= ~(1 << stim.pin);
            }
        }
        this.inputs = this.inputs >>> 0;
    }

    // Bit mask of the pins driven by a stimulus.
    stimulusMask() {
        let mask = 0;
        for (const stim of this.stimuli) mask |= (1 << stim.pin);
        return mask >>> 0;
    }

    // Whether an IRQ event fires on PIO clock `clock`.
    irqEventFires(ev, clock) {
        const t = clock - ev.delay;
        if (t < 0) return false;
        if (ev.repeat === null) return t === 0;
        if (t % ev.repeat !== 0) return false;
        return ev.count === null || t / ev.repeat < ev.count;
    }

    // Apply the IRQ events scheduled for the current clock. They stand in
    // for another state machine's `irq set` / `irq clear`, so each fires
    // once as the clock arrives; a flag toggled by hand afterwards stays
    // as it was left. Events are applied in source order.
    applyIrqEvents() {
        for (const ev of this.irqEvents) {
            if (!this.irqEventFires(ev, this.clock)) continue;
            if (ev.action === 'set') this.irq |= (1 << ev.flag);
            else this.irq &= ~(1 << ev.flag);
        }
    }

    // Bit mask of the IRQ flags touched by an event.
    irqEventMask() {
        let mask = 0;
        for (const ev of this.irqEvents) mask |= (1 << ev.flag);
        return mask;
    }

    // ---- pins ------------------------------------------------------------

    // Levels on the pads: driven by PIO where the pin is an output, by the
    // outside world otherwise.
    getAllPinStates() {
        return ((this.pins & this.pindirs) | (this.inputs & ~this.pindirs)) >>> 0;
    }

    // What the state machine observes on GPIO `pin` this cycle. There is a
    // register stage between the input mapping and the state machine, behind
    // the optional 2-FF synchroniser, so this lags the pad by one system
    // clock when bypassed and three when synchronised. Output writes reach
    // the pad one system clock after the instruction, so a state machine
    // sees its own outputs two / four system clocks later (RP2040 datasheet
    // §3.5.6.1; measured the same on RP2350).
    getPinState(pin) {
        return (this.inputsSeen >>> (pin & 0x1F)) & 1;
    }

    // IN data bus: GPIO inputs right-rotated by IN_BASE (§11.5.6.2), with
    // bits at or above IN_COUNT masked to zero (RP2350 SHIFTCTRL_IN_COUNT).
    readInPins() {
        const base = this.inBase & 0x1F;
        let val = base === 0
            ? this.inputsSeen
            : ((this.inputsSeen >>> base) | (this.inputsSeen << (32 - base)));
        if (this.inCount > 0 && this.inCount < 32) {
            val &= (1 << this.inCount) - 1;
        }
        return val >>> 0;
    }

    // Write `count` bits of `data` to pin levels or directions starting at
    // GPIO `base`, wrapping after GPIO 31 (§11.5.6).
    writePins(target, base, count, data) {
        let reg = target === 'pindirs' ? this.pindirs : this.pins;
        for (let i = 0; i < count && i < 32; i++) {
            const pin = (base + i) & 0x1F;
            if ((data >>> i) & 1) {
                reg |= (1 << pin);
            } else {
                reg &= ~(1 << pin);
            }
        }
        if (target === 'pindirs') this.pindirs = reg >>> 0;
        else this.pins = reg >>> 0;
    }

    // System clocks until the next state machine cycle. A fractional divider
    // adds one clock to some periods, with a running total of the fraction
    // (first-order delta-sigma, §11.5.5).
    nextPeriod() {
        let n = Math.floor(this.clkDiv);
        const frac = Math.floor((this.clkDiv - n) * 256);
        if (n < 1) n = 1;
        const period = n + (this.clkDivCarry ? 1 : 0);
        this.clkDivAcc += frac;
        this.clkDivCarry = this.clkDivAcc >= 256;
        this.clkDivAcc &= 255;
        return period;
    }

    // Pad levels at system clock `s`. Within cycle c (starting at system
    // clock T(c)), the pads show the earlier outputs at T(c) and this
    // cycle's output writes from T(c) + 1 on. Before the first cycle: 0.
    padAt(s) {
        for (let i = this.padRecords.length - 1; i >= 0; i--) {
            const r = this.padRecords[i];
            if (r.t === s) return r.start;
            if (r.t < s) return r.end;
        }
        return 0;
    }

    // Input latency in state machine cycles at the current divider, for
    // display: an outside level change, and the state machine's own output.
    // With a fractional divider it can vary by one cycle with the phase.
    inputLatency() {
        const c = sysclks => Math.max(1, Math.ceil(sysclks / this.clkDiv));
        return {
            external: { bypassed: c(1), synced: c(3) },
            own: { bypassed: c(2), synced: c(4) }
        };
    }

    // End a state machine cycle. `padStart` is the pad level at the start
    // of the cycle, before its output writes land.
    endCycle(padStart) {
        const padEnd = this.getAllPinStates();
        this.padRecords.push({ t: this.sysclk, start: padStart >>> 0, end: padEnd });
        if (this.padRecords.length > 8) this.padRecords.shift();
        if (this.history.length > 0) this.history[this.history.length - 1].padEnd = padEnd;

        // The input path at the next cycle's system clock t.
        this.sysclk += this.nextPeriod();
        const t = this.sysclk;
        const bypass = this.inputSyncBypass >>> 0;
        this.inputsFf1 = this.padAt(t - 1);
        this.inputsFf2 = this.padAt(t - 2);
        this.inputsSeen = ((this.padAt(t - 1) & bypass) | (this.padAt(t - 3) & ~bypass)) >>> 0;

        this.clock++;
        // Show the level the next cycle will see.
        this.applyStimuli();
        this.applyIrqEvents();
    }

    // ---- FIFOs -----------------------------------------------------------

    txCapacity() {
        if (this.fifoMode === 'tx') return 8;
        if (this.fifoMode === 'rx') return 0;
        return 4;
    }

    rxCapacity() {
        if (this.fifoMode === 'rx') return 8;
        if (this.fifoMode === 'txrx') return 4;
        return 0; // joined to TX, or repurposed as put/get registers
    }

    // Changing the FIFO join mode discards FIFO contents (§11.5.3).
    setFifoMode(mode) {
        if (mode === this.fifoMode) return;
        this.fifoMode = mode;
        this.txFifo = [];
        this.rxFifo = [];
        this.rxRegs = [0, 0, 0, 0];
    }

    // Non-OUT-cycle autopull: refill the OSR from the TX FIFO once the output
    // shift count reaches the pull threshold, if data is available. Never
    // stalls — a stall for autopull only happens on an OUT (§11.5.4.2).
    backgroundAutopull() {
        if (this.autoPull && this.osrCount >= this.effPullThresh() && this.txFifo.length > 0) {
            this.osr = this.txFifo.shift();
            this.osrCount = 0;
        }
    }

    pushTx(value) {
        if (this.txFifo.length < this.txCapacity()) {
            this.txFifo.push(value >>> 0);
            return true;
        }
        return false;
    }

    pullRx() {
        if (this.rxFifo.length > 0) {
            return this.rxFifo.shift();
        }
        return null;
    }

    // Threshold 0 is interpreted as 32.
    effPushThresh() {
        return this.pushThresh === 0 ? 32 : this.pushThresh;
    }

    effPullThresh() {
        return this.pullThresh === 0 ? 32 : this.pullThresh;
    }

    // ---- execution -------------------------------------------------------

    decodeOpts() {
        return { sidesetCount: this.sidesetCount, sidesetOpt: this.sidesetOpt, pioVersion: this.pioVersion };
    }

    // Instruction memory is 32 words; words the program did not load hold
    // their reset value 0x0000 (jmp 0).
    fetch() {
        this.pc &= 0x1F;
        return this.instructions[this.pc] || pioDecodeInstruction(0, this.decodeOpts());
    }

    // IRQ flag set addressed by an instruction, and the bit within it.
    irqTarget(instr) {
        // rel adds the state machine number to the two LSBs; this is SM0.
        const index = instr.index & 7;
        const set = instr.prev ? 'irqPrev' : (instr.next ? 'irqNext' : 'irq');
        return { set, bit: 1 << index };
    }

    statusValue() {
        if (this.statusSel === 2) {
            const flags = (this.statusN & 0x10) ? this.irqNext : ((this.statusN & 0x08) ? this.irqPrev : this.irq);
            return ((flags >> (this.statusN & 7)) & 1) ? 0xFFFFFFFF : 0;
        }
        const level = this.statusSel === 1 ? this.rxFifo.length : this.txFifo.length;
        return level < this.statusN ? 0xFFFFFFFF : 0;
    }

    fail(message) {
        this.error = message;
        this.status = 'error';
    }

    step() {
        if (this.error) return;

        if (this.instructions.length === 0) return;

        // A stimulus owns its pin: re-apply so a manual toggle cannot linger.
        this.applyStimuli();
        // Pad levels during this cycle. Outputs written by this cycle's
        // instruction reach the pads on the next one.
        const pad = this.getAllPinStates();

        this.history.push({
            clock: this.clock,
            sysclk: this.sysclk,
            pad,
            pins: this.pins,
            inputs: this.inputs,
            irq: this.irq,
            pc: this.pc,
            x: this.x,
            y: this.y,
            osr: this.osr,
            osrCount: this.osrCount,
            isr: this.isr,
            isrCount: this.isrCount
        });

        // Delay cycles are idle. Autopull can still refill the OSR in the
        // background on these non-OUT cycles, but never stalls here.
        if (this.delay > 0) {
            this.backgroundAutopull();
            this.delay--;
            this.endCycle(pad);
            return;
        }

        // An EXEC'd instruction runs from the latch instead of the
        // instruction memory, and does not advance PC (§11.5.7).
        const fromLatch = this.execLatch !== null;
        let instr;
        try {
            instr = fromLatch ? this.execLatch : this.fetch();
        } catch (e) {
            this.fail(e.message);
            return;
        }

        // A stalled instruction is re-executed each cycle; its side-set
        // belongs to the first cycle only (§11.2.5).
        const firstCycle = this.status !== 'stalled';

        // On non-OUT cycles autopull may refill an empty OSR in the
        // background. MOV to OSR and PULL zero the shift count first, so no
        // pull happens on those cycles (§11.5.4.2 pseudocode). OUT cycles
        // are handled in executeOut, including the one-cycle refill stall.
        const writesOsr = instr.type === 'PULL' || (instr.type === 'MOV' && instr.dest === 'osr');
        if (instr.type !== 'OUT' && !writesOsr) {
            this.backgroundAutopull();
        }

        let executed = true;
        let jumped = false;         // PC explicitly changed by JMP
        this.pcOverride = null;     // PC explicitly written by MOV/OUT dest=PC
        this.execRequest = null;    // instruction word handed to EXEC

        try {
            switch (instr.type) {
                case 'JMP':
                    // A taken JMP bypasses wrap even when its target is PC+1.
                    jumped = this.executeJmp(instr);
                    break;
                case 'WAIT':
                    executed = this.executeWait(instr);
                    break;
                case 'IN':
                    executed = this.executeIn(instr);
                    break;
                case 'OUT':
                    executed = this.executeOut(instr);
                    break;
                case 'PUSH':
                    executed = this.executePush(instr);
                    break;
                case 'PULL':
                    executed = this.executePull(instr);
                    break;
                case 'MOV':
                    this.executeMov(instr);
                    break;
                case 'IRQ':
                    executed = this.executeIrq(instr);
                    break;
                case 'SET':
                    this.executeSet(instr);
                    break;
            }

            // Side-set is applied after the instruction's own pin writes: when
            // both hit the same pin on the same cycle, side-set wins (§11.5.1).
            // It still takes effect when the instruction stalls.
            if (firstCycle) this.applySideSet(instr);

            if (executed) {
                this.status = 'running';
                if (fromLatch) this.execLatch = null;

                if (this.execRequest !== null) {
                    // The executee runs from the latch once this
                    // instruction's delay cycles are over. The datasheet
                    // (§11.4.5) says that delay is ignored, but measured on
                    // RP2040 and RP2350 it is not: `out exec, 16 [5]` runs
                    // the executee 5 cycles later. The executee may add
                    // its own delay as usual.
                    this.execLatch = pioDecodeInstruction(this.execRequest, this.decodeOpts());
                }
                if (instr.delay > 0) {
                    // Delay only applies after a successful (non-stalled) execution.
                    this.delay = instr.delay;
                }

                if (this.pcOverride !== null) {
                    // MOV/OUT dest=PC: unconditional jump, wrap does not apply.
                    this.pc = this.pcOverride & 0x1F;
                } else if (jumped) {
                    this.pc = instr.target & 0x1F;
                } else if (!fromLatch) {
                    // §11.5.2: wrap at WRAP_TOP, otherwise increment, 31 -> 0.
                    this.pc = this.pc === this.wrap ? this.wrapTarget : (this.pc + 1) & 0x1F;
                }
            } else {
                this.status = 'stalled';
            }
        } catch (e) {
            this.fail(e.message);
            return;
        }

        this.endCycle(pad);
    }

    applySideSet(instr) {
        if (this.sidesetCount === 0) return;
        let value = instr.sideSet;
        if (value === null || value === undefined) {
            // With an enable bit (opt), no `side` means no side-set.
            if (this.sidesetOpt) return;
            value = 0;
        }
        this.writePins(this.sidesetPindirs ? 'pindirs' : 'pins', this.sidesetBase, this.sidesetCount, value);
    }

    executeJmp(instr) {
        switch (instr.cond) {
            case '': return true;
            case '!x': return this.x === 0;
            case 'x--': {
                // Branch on the value before the decrement; always decrement.
                const taken = this.x !== 0;
                this.x = (this.x - 1) >>> 0;
                return taken;
            }
            case '!y': return this.y === 0;
            case 'y--': {
                const taken = this.y !== 0;
                this.y = (this.y - 1) >>> 0;
                return taken;
            }
            case 'x!=y': return this.x !== this.y;
            case 'pin': return this.getPinState(this.jmpPin) === 1;
            case '!osre': return this.osrCount < this.effPullThresh();
            default: return false;
        }
    }

    executeWait(instr) {
        let val = 0;
        if (instr.source === 'gpio') {
            // Absolute GPIO number; the input mapping is not applied.
            val = this.getPinState(instr.index);
        } else if (instr.source === 'pin') {
            val = (this.readInPins() >>> (instr.index & 0x1F)) & 1;
        } else if (instr.source === 'jmppin') {
            val = this.getPinState(this.jmpPin + instr.index);
        } else if (instr.source === 'irq') {
            const { set, bit } = this.irqTarget(instr);
            val = (this[set] & bit) ? 1 : 0;
            // WAIT 1 IRQ clears the flag once the condition is met.
            if (instr.polarity === 1 && val === 1) {
                this[set] &= ~bit;
            }
        }

        return val === instr.polarity;
    }

    executeIn(instr) {
        let val = 0;
        switch (instr.source) {
            case 'pins': val = this.readInPins(); break;
            case 'x': val = this.x; break;
            case 'y': val = this.y; break;
            case 'null': val = 0; break;
            case 'isr': val = this.isr; break;
            case 'osr': val = this.osr; break;
            case 'status': val = this.statusValue(); break;
        }

        const bitCount = instr.bitCount;
        const mask = bitCount === 32 ? 0xFFFFFFFF : (1 << bitCount) - 1;
        const data = val & mask;

        let newIsr;
        if (bitCount === 32) {
            newIsr = data;
        } else if (this.inShiftDir === 'right') {
            // Right shift: new data enters at the MSB end.
            newIsr = (this.isr >>> bitCount) | (data << (32 - bitCount));
        } else {
            // Left shift: new data enters at the LSB end.
            newIsr = (this.isr << bitCount) | data;
        }
        newIsr = newIsr >>> 0;

        const newIsrCount = Math.min(32, this.isrCount + bitCount);

        // Autopush (§11.5.4.1) is part of the IN, in the same cycle: once the
        // shift reaches the push threshold, the ISR is written to the RX FIFO
        // and cleared. If the RX FIFO is full, the IN itself stalls and the PC
        // holds. Decide this before committing the shift so the IN
        // re-executes cleanly next cycle rather than double-shifting.
        const willPush = this.autoPush && newIsrCount >= this.effPushThresh();
        if (willPush && this.rxFifo.length >= this.rxCapacity()) {
            return false;
        }

        this.isr = newIsr;
        this.isrCount = newIsrCount;

        if (willPush) {
            this.rxFifo.push(this.isr);
            this.isr = 0;
            this.isrCount = 0;
        }
        return true;
    }

    executeOut(instr) {
        // OUT-cycle autopull (§11.5.4.2). If the OSR is already empty (shift
        // count at/over the pull threshold), the hardware cannot refill and
        // OUT on the same cycle: refill from the TX FIFO if data is available,
        // but stall this cycle regardless so the refilled word is shifted out
        // on the following cycle.
        if (this.autoPull && this.osrCount >= this.effPullThresh()) {
            if (this.txFifo.length > 0) {
                this.osr = this.txFifo.shift();
                this.osrCount = 0;
            }
            return false;
        }

        const bitCount = instr.bitCount;
        let data;
        if (bitCount === 32) {
            data = this.osr;
            this.osr = 0;
        } else if (this.outShiftDir === 'right') {
            data = this.osr & ((1 << bitCount) - 1);
            this.osr = this.osr >>> bitCount;
        } else {
            data = this.osr >>> (32 - bitCount);
            this.osr = (this.osr << bitCount) >>> 0;
        }
        data = data >>> 0;

        this.osrCount = Math.min(32, this.osrCount + bitCount);

        // After shifting out the last of the data, the OSR can be refilled in
        // the same cycle (these operations run in parallel, so this refill
        // does NOT stall). If the TX FIFO is empty, the shift count stays
        // at/over threshold and the next OUT takes the stall branch above.
        if (this.autoPull && this.osrCount >= this.effPullThresh() && this.txFifo.length > 0) {
            this.osr = this.txFifo.shift();
            this.osrCount = 0;
        }

        // A 32-bit value is written to the destination: the low `bitCount`
        // bits come from the OSR and the rest are zero (§11.4.5). For PINS
        // and PINDIRS it lands on OUT_COUNT pins starting at OUT_BASE.
        switch (instr.dest) {
            case 'pins':
            case 'pindirs':
                this.writePins(instr.dest, this.outBase, this.outCount, data);
                break;
            case 'x': this.x = data; break;
            case 'y': this.y = data; break;
            case 'null': break;
            case 'pc': this.pcOverride = data; break;
            case 'isr':
                this.isr = data;
                this.isrCount = bitCount;
                break;
            case 'exec':
                this.execRequest = data & 0xFFFF;
                break;
        }
        return true;
    }

    executePush(instr) {
        if (this.fifoMode === 'txput' || this.fifoMode === 'txget' || this.fifoMode === 'putget') {
            throw new Error('PUSH is undefined while the RX FIFO is in put/get mode (§11.4.6)');
        }

        // A plain PUSH is unconditional even when autopush is enabled: only
        // IfFull gates PUSH on the threshold.
        if (instr.iffull && this.isrCount < this.effPushThresh()) {
            return true;
        }

        if (this.rxFifo.length >= this.rxCapacity()) {
            if (instr.block) {
                return false;
            }
            // Non-blocking push to a full FIFO: the data is lost, the ISR is
            // still cleared.
            this.isr = 0;
            this.isrCount = 0;
            return true;
        }

        this.rxFifo.push(this.isr);
        this.isr = 0;
        this.isrCount = 0;
        return true;
    }

    executePull(instr) {
        // With autopull enabled, PULL is a no-op while the OSR still has data.
        if (this.autoPull && this.osrCount < this.effPullThresh()) {
            return true;
        }

        if (instr.ifempty && this.osrCount < this.effPullThresh()) {
            return true;
        }

        if (this.txFifo.length === 0) {
            if (instr.block) {
                return false;
            }
            // noblock with empty FIFO: same effect as MOV OSR, X.
            this.osr = this.x;
            this.osrCount = 0;
            return true;
        }

        this.osr = this.txFifo.shift();
        this.osrCount = 0;
        return true;
    }

    // Index of an RX FIFO storage register for MOV RXFIFO: immediate, or the
    // two LSBs of Y.
    rxRegIndex(instr) {
        return (instr.index === null || instr.index === undefined) ? (this.y & 3) : (instr.index & 3);
    }

    executeMov(instr) {
        // RP2350: MOV RXFIFO[i], ISR (put) and MOV OSR, RXFIFO[i] (get).
        if (instr.dest === 'rxfifo') {
            if (this.fifoMode !== 'txput' && this.fifoMode !== 'putget') {
                throw new Error('MOV RXFIFO[], ISR needs the FIFO in txput or putget mode (FJOIN_RX_PUT)');
            }
            this.rxRegs[this.rxRegIndex(instr)] = this.isr >>> 0;
            return;
        }
        if (instr.src === 'rxfifo') {
            if (this.fifoMode !== 'txget' && this.fifoMode !== 'putget') {
                throw new Error('MOV OSR, RXFIFO[] needs the FIFO in txget or putget mode (FJOIN_RX_GET)');
            }
            this.osr = this.rxRegs[this.rxRegIndex(instr)] >>> 0;
            this.osrCount = 0;
            return;
        }

        let val = 0;
        switch (instr.src) {
            case 'pins': val = this.readInPins(); break;
            case 'x': val = this.x; break;
            case 'y': val = this.y; break;
            case 'null': val = 0; break;
            case 'status': val = this.statusValue(); break;
            case 'isr': val = this.isr; break;
            case 'osr': val = this.osr; break;
        }

        if (instr.op === '~') {
            val = ~val;
        } else if (instr.op === '::') {
            val = pioReverseBits(val);
        }
        val = val >>> 0;

        switch (instr.dest) {
            case 'pins':
            case 'pindirs':
                // Same pin mapping as OUT: OUT_COUNT pins from OUT_BASE.
                this.writePins(instr.dest, this.outBase, this.outCount, val);
                break;
            case 'x': this.x = val; break;
            case 'y': this.y = val; break;
            case 'exec': this.execRequest = val & 0xFFFF; break;
            case 'pc': this.pcOverride = val; break;
            case 'isr': this.isr = val; this.isrCount = 0; break;
            case 'osr': this.osr = val; this.osrCount = 0; break;
        }
    }

    executeIrq(instr) {
        const { set, bit } = this.irqTarget(instr);

        if (instr.clear) {
            this[set] &= ~bit;
            this.irqWaitStalled = false;
            this.irqWaitPc = -1;
            return true;
        }

        const continuingSameWait = this.irqWaitStalled && this.irqWaitPc === this.pc;

        // Raise the flag only on the first cycle. During a wait stall the
        // instruction is re-executed every cycle, so raising it again would
        // undo the clear that is meant to release this wait.
        if (!continuingSameWait) {
            this[set] |= bit;
        }

        if (instr.wait && (this[set] & bit)) {
            this.irqWaitStalled = true;
            this.irqWaitPc = this.pc;
            return false;
        }
        this.irqWaitStalled = false;
        this.irqWaitPc = -1;
        return true;
    }

    executeSet(instr) {
        const val = instr.value & 0x1F;
        switch (instr.dest) {
            case 'pins':
            case 'pindirs':
                this.writePins(instr.dest, this.setBase, this.setCount, val);
                break;
            // The 5 LSBs are set to the data, all other bits cleared.
            case 'x': this.x = val; break;
            case 'y': this.y = val; break;
        }
    }
}
