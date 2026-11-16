// Emulator for one PIO block: four state machines sharing instruction
// memory, GPIOs and IRQ flags.
//
// Behaviour follows the PIO chapters of the RP2040 and RP2350 datasheets,
// and where those disagree with the chips, measurements on a real RP2040
// and RP2350. Section numbers in comments refer to the RP2350 datasheet
// unless noted. Configuration defaults are the hardware register reset
// values.
//
// Time runs on the system clock. Each state machine runs on the system
// clocks its clock divider enables; a step advances to the next system
// clock on which any enabled state machine runs.

// State machine settings and their reset values. They are configuration,
// so reset() keeps them, as SM_RESTART does on the chip.
const PIO_SM_CONFIG_DEFAULTS = {
    outBase: 0,
    outCount: 0,        // PINCTRL_OUT_COUNT resets to 0
    setBase: 0,
    setCount: 5,        // PINCTRL_SET_COUNT resets to 5
    sidesetBase: 0,
    inBase: 0,
    inCount: 32,        // SHIFTCTRL_IN_COUNT (RP2350); 32 = no masking
    jmpPin: 0,
    inShiftDir: 'right',
    outShiftDir: 'right',
    autoPush: false,
    autoPull: false,
    pushThresh: 32,
    pullThresh: 32,
    statusSel: 0,       // 0 = TX FIFO level, 1 = RX FIFO level, 2 = IRQ flag (RP2350)
    statusN: 0,
    clkDiv: 1           // CLKDIV, 16.8 fixed point
};

// System clocks from a change on the pad to JMP PIN seeing it, with the
// input synchroniser bypassed / engaged. Measured on a Pico and a Pico 2 (a
// state machine sees its own output 1 / 3 clocks later with JMP PIN on
// RP2040, 2 / 3 on RP2350). The other inputs (IN PINS, WAIT PIN/GPIO/
// JMPPIN, MOV x, PINS) lag 1 / 3 on both chips, so 2 / 4 for own outputs.
const PIO_JMP_PIN_LAG = {
    rp2040: { bypassed: 0, synced: 2 },
    rp2350: { bypassed: 1, synced: 2 }
};

class PioStateMachine {
    constructor(block, index) {
        this.block = block;
        this.index = index;
        this.enabled = index === 0;
        this.program = null;        // program running on this state machine
        this.entry = 0;             // address it starts from
        this.wrapTarget = 0;
        this.wrap = 31;
        this.sidesetCount = 0;      // side-set data bits (.side_set count)
        this.sidesetOpt = false;
        this.sidesetPindirs = false;
        // From `; #pragma pio_sim dma put` / `dma get` (set by loadProgram).
        this.dma = { put: [], loop: false, get: false };
        Object.assign(this, PIO_SM_CONFIG_DEFAULTS);
        // txrx | tx | rx | txput | txget | putget (SHIFTCTRL_FJOIN_*)
        this.fifoMode = 'txrx';
        this.txFifo = [];
        this.rxFifo = [];
        this.rxRegs = [0, 0, 0, 0];
        this.resetState();
    }

    // SM_RESTART plus FIFO flush and PC to the entry point.
    resetState() {
        this.pc = this.entry;
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
        this.delay = 0;
        // Instruction latched by OUT EXEC / MOV EXEC, run on the next cycle.
        this.execLatch = null;
        this.irqWaitStalled = false; // sticky while an IRQ wait is stalling
        this.irqWaitPc = -1;
        this.status = 'stopped';
        this.cycles = 0;            // state machine cycles since reset
        this.nextTime = 0;          // system clock of the next cycle
        this.clkDivAcc = 0;
        this.clkDivCarry = false;
        this.dmaPos = 0;            // next word of dma.put
        this.dmaRead = [];          // words read by `dma get`, oldest first
    }

    // ---- DMA (`; #pragma pio_sim dma put` / `dma get`) --------------------
    //
    // The system side of the FIFOs, as a DMA channel paced by the FIFO's
    // DREQ would do it, without its latency: the TX FIFO is topped up
    // before every step, the RX FIFO emptied after it.

    dmaPut() {
        const words = this.dma.put;
        if (words.length === 0) return;
        while (this.txFifo.length < this.txCapacity()) {
            if (this.dmaPos >= words.length) {
                if (!this.dma.loop) return;
                this.dmaPos = 0;
            }
            this.txFifo.push(words[this.dmaPos++]);
        }
    }

    dmaGet() {
        if (!this.dma.get) return;
        while (this.rxFifo.length > 0) this.dmaRead.push(this.rxFifo.shift());
        if (this.dmaRead.length > 256) this.dmaRead.splice(0, this.dmaRead.length - 256);
    }

    // ---- clock -----------------------------------------------------------

    // System clocks until the next state machine cycle. A fractional divider
    // adds one clock to some periods, with a running total of the fraction
    // (first-order delta-sigma, §11.5.5; order matched against RP2350).
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

    // Input latency in state machine cycles at the current divider, for
    // display: an outside level change, and the state machine's own output.
    // With a fractional divider it can vary by one cycle with the phase.
    inputLatency() {
        const c = sysclks => Math.max(1, Math.ceil(sysclks / this.clkDiv));
        const jmp = PIO_JMP_PIN_LAG[this.block.chip];
        return {
            external: { bypassed: c(1), synced: c(3) },
            own: { bypassed: c(2), synced: c(4) },
            // JMP PIN reads the pin through a shorter path (measured).
            jmpOwn: { bypassed: c(jmp.bypassed + 1), synced: c(jmp.synced + 1) }
        };
    }

    // ---- pins ------------------------------------------------------------

    getPinState(pin) {
        return this.block.getPinState(pin);
    }

    // IN data bus: GPIO inputs right-rotated by IN_BASE (§11.5.6.2), with
    // bits at or above IN_COUNT masked to zero (RP2350 SHIFTCTRL_IN_COUNT).
    readInPins() {
        const seen = this.block.inputsSeen;
        const base = this.inBase & 0x1F;
        let val = base === 0 ? seen : ((seen >>> base) | (seen << (32 - base)));
        if (this.inCount > 0 && this.inCount < 32) {
            val &= (1 << this.inCount) - 1;
        }
        return val >>> 0;
    }

    writePins(target, base, count, data) {
        this.block.writePins(target, base, count, data);
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
        return { sidesetCount: this.sidesetCount, sidesetOpt: this.sidesetOpt, pioVersion: this.block.pioVersion };
    }

    // Instruction memory is 32 words shared by all state machines; words no
    // program loaded hold their reset value 0x0000 (jmp 0).
    fetch() {
        this.pc &= 0x1F;
        return this.block.instructions[this.pc] || pioDecodeInstruction(0, this.decodeOpts());
    }

    // IRQ flag set addressed by an instruction, and the bit within it.
    // `rel` adds the state machine number to the two LSBs (§11.4.11).
    irqTarget(instr) {
        let index = instr.index & 7;
        if (instr.rel) index = (index & 4) | ((index + this.index) & 3);
        const set = instr.prev ? 'irqPrev' : (instr.next ? 'irqNext' : 'irq');
        return { set, bit: 1 << index };
    }

    statusValue() {
        const b = this.block;
        if (this.statusSel === 2) {
            const flags = (this.statusN & 0x10) ? b.irqNext : ((this.statusN & 0x08) ? b.irqPrev : b.irq);
            return ((flags >> (this.statusN & 7)) & 1) ? 0xFFFFFFFF : 0;
        }
        const level = this.statusSel === 1 ? this.rxFifo.length : this.txFifo.length;
        return level < this.statusN ? 0xFFFFFFFF : 0;
    }

    // Run one state machine cycle. Throws on an error.
    cycle() {
        // Delay cycles are idle. Autopull can still refill the OSR in the
        // background on these non-OUT cycles, but never stalls here.
        if (this.delay > 0) {
            this.backgroundAutopull();
            this.delay--;
            return;
        }

        // An EXEC'd instruction runs from the latch instead of the
        // instruction memory, and does not advance PC (§11.5.7).
        const fromLatch = this.execLatch !== null;
        const instr = fromLatch ? this.execLatch : this.fetch();

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

        switch (instr.type) {
            case 'JMP':
                // A taken JMP bypasses wrap even when its target is PC+1.
                jumped = this.executeJmp(instr);
                break;
            case 'WAIT': executed = this.executeWait(instr); break;
            case 'IN': executed = this.executeIn(instr); break;
            case 'OUT': executed = this.executeOut(instr); break;
            case 'PUSH': executed = this.executePush(instr); break;
            case 'PULL': executed = this.executePull(instr); break;
            case 'MOV': this.executeMov(instr); break;
            case 'IRQ': executed = this.executeIrq(instr); break;
            case 'SET': this.executeSet(instr); break;
        }

        // Side-set is applied after the instruction's own pin writes: when
        // both hit the same pin on the same cycle, side-set wins (§11.5.1).
        // It still takes effect when the instruction stalls.
        if (firstCycle) this.applySideSet(instr);

        if (!executed) {
            this.status = 'stalled';
            return;
        }

        this.status = 'running';
        if (fromLatch) this.execLatch = null;

        if (this.execRequest !== null) {
            // The executee runs from the latch once this instruction's delay
            // cycles are over. The datasheet (§11.4.5) says that delay is
            // ignored, but measured on RP2040 and RP2350 it is not:
            // `out exec, 16 [5]` runs the executee 5 cycles later. The
            // executee may add its own delay as usual.
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
            case 'pin': return this.block.getJmpPinState(this.jmpPin) === 1;
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
            val = (this.block[set] & bit) ? 1 : 0;
            // WAIT 1 IRQ clears the flag once the condition is met.
            if (instr.polarity === 1 && val === 1) {
                this.block.irqWrite(set, bit, false);
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
            this.block.irqWrite(set, bit, false);
            this.irqWaitStalled = false;
            this.irqWaitPc = -1;
            return true;
        }

        const continuingSameWait = this.irqWaitStalled && this.irqWaitPc === this.pc;

        // Raise the flag only on the first cycle. During a wait stall the
        // instruction is re-executed every cycle, so raising it again would
        // undo the clear that is meant to release this wait.
        if (!continuingSameWait) {
            this.block.irqWrite(set, bit, true);
        }

        // IRQ WAIT holds until the flag it raised is low again. The flag
        // just raised becomes visible next cycle, so the first cycle always
        // waits.
        if (instr.wait && (!continuingSameWait || (this.block[set] & bit))) {
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

class PioEmulator {
    constructor() {
        this.instructions = [];     // 32-word instruction memory
        this.programs = [];         // what loadProgram put in it
        this.pioVersion = 1;        // 0 = RP2040, 1 = RP2350
        // Input waveforms from `; #pragma pio_sim pin ...` (owned by loadProgram).
        this.stimuli = [];
        // IRQ flag events from `; #pragma pio_sim irq ...` (owned by loadProgram).
        this.irqEvents = [];
        // INPUT_SYNC_BYPASS resets to 0: every input passes through the
        // 2-flipflop synchroniser. 1 = bypassed for that GPIO.
        this.inputSyncBypass = 0;
        // Which chip's timing to follow: 'rp2040' or 'rp2350'. They differ in
        // how fast JMP PIN sees a pin (PIO_JMP_PIN_LAG).
        this.chip = 'rp2350';
        this.sms = [0, 1, 2, 3].map(i => new PioStateMachine(this, i));
        this.reset();
    }

    reset() {
        this.clock = 0;     // steps since reset
        this.sysclk = 0;    // system clock of the next step
        // Pad levels of the last few steps, for the input path.
        this.padRecords = [];

        this.pins = 0;      // output level register
        this.pindirs = 0;   // output enable register: 1 = out, 0 = in
        this.inputs = 0;    // levels driven onto the pads from outside
        // Input path: pad -> [FF1 -> FF2 unless bypassed] -> input register
        // -> state machines. `inputsSeen` is what a state machine reads.
        this.inputsFf1 = 0;
        this.inputsFf2 = 0;
        this.inputsSeen = 0;
        this.jmpPinSeen = 0;    // what JMP PIN reads (a shorter path)

        this.history = [];
        this.irq = 0;
        this.irqPrev = 0;
        this.irqNext = 0;
        this.error = null;

        for (const sm of this.sms) sm.resetState();

        this.applyStimuli(0);
        this.applyIrqEvents(0, 0);
    }

    // Load assembled code. `programData` is what PioAssembler.assemble()
    // returns: the instruction memory, the programs in it and which state
    // machine runs which program.
    loadProgram(programData) {
        this.pioVersion = programData.pioVersion === undefined ? 1 : programData.pioVersion;
        this.stimuli = programData.stimuli || [];
        this.irqEvents = programData.irqEvents || [];

        if (programData.memory) {
            this.instructions = programData.memory;
            this.programs = programData.programs;
            this.sms.forEach((sm, i) => {
                const p = programData.smPrograms[i] === null ? null : programData.programs[programData.smPrograms[i]];
                this.assign(sm, p);
                sm.dma = (programData.smDma && programData.smDma[i]) || { put: [], loop: false, get: false };
            });
        } else {
            // A single program at address 0, run by SM0.
            const p = {
                name: programData.programName || 'program', offset: 0,
                wrapTarget: programData.wrapTarget, wrap: programData.wrap,
                sidesetCount: programData.sidesetCount || 0,
                sidesetOpt: programData.sidesetOpt || false,
                sidesetPindirs: programData.sidesetPindirs || false
            };
            this.instructions = programData.instructions;
            this.programs = [p];
            this.sms.forEach((sm, i) => {
                this.assign(sm, i === 0 ? p : null);
                sm.dma = { put: [], loop: false, get: false };
            });
        }
        this.reset();
    }

    assign(sm, program) {
        sm.program = program;
        sm.enabled = program !== null;
        if (!program) return;
        sm.entry = program.offset;
        sm.wrapTarget = program.wrapTarget;
        sm.wrap = program.wrap;
        sm.sidesetCount = program.sidesetCount;
        sm.sidesetOpt = program.sidesetOpt;
        sm.sidesetPindirs = program.sidesetPindirs;
    }

    enabledSms() {
        return this.sms.filter(sm => sm.enabled);
    }

    // ---- stimulus --------------------------------------------------------

    // Level a stimulus drives on its pin at system clock `clock`.
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

    // Levels driven by the stimuli at system clock `s`, over the manual
    // input levels `inputs`.
    inputsAt(s, inputs) {
        for (const stim of this.stimuli) {
            if (this.stimulusLevel(stim, s)) inputs |= (1 << stim.pin);
            else inputs &= ~(1 << stim.pin);
        }
        return inputs >>> 0;
    }

    // Drive the stimulated input pins with their level at system clock `s`
    // (default: the current one).
    applyStimuli(s = this.sysclk) {
        this.inputs = this.inputsAt(s, this.inputs);
    }

    // Bit mask of the pins driven by a stimulus.
    stimulusMask() {
        let mask = 0;
        for (const stim of this.stimuli) mask |= (1 << stim.pin);
        return mask >>> 0;
    }

    // Whether an IRQ event fires at system clock `clock`.
    irqEventFires(ev, clock) {
        const t = clock - ev.delay;
        if (t < 0) return false;
        if (ev.repeat === null) return t === 0;
        if (t % ev.repeat !== 0) return false;
        return ev.count === null || t / ev.repeat < ev.count;
    }

    // Apply the IRQ events of system clocks `from` to `to`. They stand in
    // for another state machine's `irq set` / `irq clear`, so each fires
    // once as its clock arrives; a flag toggled by hand afterwards stays as
    // it was left. Events are applied in time, then source order.
    applyIrqEvents(from, to) {
        if (this.irqEvents.length === 0) return;
        for (let s = from; s <= to; s++) {
            for (const ev of this.irqEvents) {
                if (!this.irqEventFires(ev, s)) continue;
                if (ev.action === 'set') this.irq |= (1 << ev.flag);
                else this.irq &= ~(1 << ev.flag);
            }
        }
    }

    // Bit mask of the IRQ flags touched by an event.
    irqEventMask() {
        let mask = 0;
        for (const ev of this.irqEvents) mask |= (1 << ev.flag);
        return mask;
    }

    // IRQ flag writes by state machines take effect at the end of the cycle,
    // so every state machine, the writer included, sees them on the next
    // cycle. If one state machine sets a flag and another clears it on the
    // same cycle, the set wins. The datasheet says neither; both were
    // measured on RP2040 and RP2350.
    irqWrite(set, bit, value) {
        const p = this.irqPending[set];
        if (value) p.set |= bit;
        else p.clear |= bit;
    }

    commitIrqWrites() {
        for (const set of ['irq', 'irqPrev', 'irqNext']) {
            const p = this.irqPending[set];
            this[set] = ((this[set] & ~p.clear) | p.set) & 0xFF;
        }
    }

    // ---- pins ------------------------------------------------------------

    // Levels on the pads: driven by PIO where the pin is an output, by the
    // outside world otherwise.
    getAllPinStates() {
        return ((this.pins & this.pindirs) | (this.inputs & ~this.pindirs)) >>> 0;
    }

    // What a state machine observes on GPIO `pin` this cycle. There is a
    // register stage between the input mapping and the state machine, behind
    // the optional 2-FF synchroniser, so this lags the pad by one system
    // clock when bypassed and three when synchronised. Output writes reach
    // the pad one system clock after the instruction, so a state machine
    // sees its own outputs two / four system clocks later (RP2040 datasheet
    // §3.5.6.1; measured the same on RP2350).
    getPinState(pin) {
        return (this.inputsSeen >>> (pin & 0x1F)) & 1;
    }

    // What JMP PIN observes. Measured, it lags the pad less than the other
    // inputs do, and differently on each chip (PIO_JMP_PIN_LAG). WAIT
    // JMPPIN, despite the name, uses the ordinary input path.
    getJmpPinState(pin) {
        return (this.jmpPinSeen >>> (pin & 0x1F)) & 1;
    }

    // Write `count` bits of `data` to pin levels or directions starting at
    // GPIO `base`, wrapping after GPIO 31 (§11.5.6). State machines run in
    // number order within a cycle, so when several write the same pin on
    // the same cycle the highest-numbered one wins (§11.5.6.1).
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

    // Pad levels at system clock `s`. Within a step at system clock T, the
    // pads show the earlier outputs at T and that step's output writes from
    // T + 1 on. Stimulated pins follow their waveform on every system clock.
    // Before the first step: 0.
    padAt(s) {
        for (let i = this.padRecords.length - 1; i >= 0; i--) {
            const r = this.padRecords[i];
            if (r.t > s) continue;
            const pins = r.t === s ? r.startPins : r.endPins;
            const dirs = r.t === s ? r.startDirs : r.endDirs;
            const inputs = this.inputsAt(s, r.inputs);
            return ((pins & dirs) | (inputs & ~dirs)) >>> 0;
        }
        return 0;
    }

    fail(sm, message) {
        const multi = this.enabledSms().length > 1;
        this.error = multi ? `SM${sm.index}: ${message}` : message;
        sm.status = 'error';
    }

    // Advance to the next system clock on which a state machine runs.
    step() {
        if (this.error) return;
        const active = this.enabledSms();
        if (active.length === 0 || this.instructions.length === 0) return;

        const t = this.sysclk;
        // A stimulus owns its pin: re-apply so a manual toggle cannot linger.
        this.applyStimuli(t);
        for (const sm of active) sm.dmaPut();
        // Pad levels at this system clock. Outputs written now reach the
        // pads on the next one.
        const pad = this.getAllPinStates();
        const startPins = this.pins;
        const startDirs = this.pindirs;
        const sm0 = this.sms[0];

        this.history.push({
            clock: this.clock,
            sysclk: t,
            pad,
            pins: this.pins,
            pindirs: this.pindirs,
            inputs: this.inputs,
            irq: this.irq,
            // SM0, kept at the top level for single state machine use.
            pc: sm0.pc,
            x: sm0.x,
            y: sm0.y,
            osr: sm0.osr,
            osrCount: sm0.osrCount,
            isr: sm0.isr,
            isrCount: sm0.isrCount,
            sms: this.sms.map(sm => sm.enabled
                ? { pc: sm.pc, x: sm.x, y: sm.y, osr: sm.osr, isr: sm.isr, status: sm.status, ran: sm.nextTime === t }
                : null)
        });

        this.irqPending = {
            irq: { set: 0, clear: 0 }, irqPrev: { set: 0, clear: 0 }, irqNext: { set: 0, clear: 0 }
        };
        const ran = [];
        for (const sm of active) {
            if (sm.nextTime !== t) continue;
            try {
                sm.cycle();
            } catch (e) {
                this.fail(sm, e.message);
                return;
            }
            ran.push(sm);
        }
        this.commitIrqWrites();
        for (const sm of active) sm.dmaGet();

        const padEnd = this.getAllPinStates();
        this.history[this.history.length - 1].padEnd = padEnd;
        this.padRecords.push({
            t, startPins, startDirs, endPins: this.pins, endDirs: this.pindirs,
            inputs: this.inputs & ~this.stimulusMask()
        });
        if (this.padRecords.length > 8) this.padRecords.shift();

        for (const sm of ran) {
            sm.nextTime = t + sm.nextPeriod();
            sm.cycles++;
        }
        const tn = Math.min(...active.map(sm => sm.nextTime));

        this.applyIrqEvents(t + 1, tn);

        // The input path at the next step's system clock.
        this.sysclk = tn;
        const bypass = this.inputSyncBypass >>> 0;
        this.inputsFf1 = this.padAt(tn - 1);
        this.inputsFf2 = this.padAt(tn - 2);
        this.inputsSeen = ((this.padAt(tn - 1) & bypass) | (this.padAt(tn - 3) & ~bypass)) >>> 0;
        const jmp = PIO_JMP_PIN_LAG[this.chip] || PIO_JMP_PIN_LAG.rp2350;
        this.jmpPinSeen = ((this.padAt(tn - jmp.bypassed) & bypass) | (this.padAt(tn - jmp.synced) & ~bypass)) >>> 0;

        this.clock++;
        // Show the level the next step will see.
        this.applyStimuli(tn);
    }
}

// Single state machine use: the per-state-machine fields and methods of
// SM0 are reachable on the emulator itself (emulator.pc, emulator.pushTx...).
for (const key of [
    'pc', 'x', 'y', 'osr', 'isr', 'osrCount', 'isrCount', 'txFifo', 'rxFifo', 'rxRegs',
    'delay', 'execLatch', 'wrapTarget', 'wrap', 'sidesetCount', 'sidesetOpt', 'sidesetPindirs',
    'fifoMode', 'status', 'irqWaitStalled', 'irqWaitPc', ...Object.keys(PIO_SM_CONFIG_DEFAULTS)
]) {
    Object.defineProperty(PioEmulator.prototype, key, {
        get() { return this.sms[0][key]; },
        set(v) { this.sms[0][key] = v; }
    });
}
for (const method of [
    'pushTx', 'pullRx', 'setFifoMode', 'txCapacity', 'rxCapacity',
    'effPushThresh', 'effPullThresh', 'inputLatency', 'readInPins'
]) {
    PioEmulator.prototype[method] = function (...args) {
        return this.sms[0][method](...args);
    };
}
