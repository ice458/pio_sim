class PioEmulator {
    constructor() {
        this.instructions = [];
        this.wrapTarget = 0;
        this.wrap = 0;
        // 1 = bypass synchronizer (matches the simulator's historical zero-delay
        // behavior). Hardware default is 0 (engaged); we preserve simulator UX
        // and let the user opt into the 2-cycle delay per pin.
        this.inputSyncBypass = 0xFFFFFFFF;
        this.reset();
    }

    reset() {
        this.pc = 0;
        this.x = 0;
        this.y = 0;
        this.osr = 0;
        this.isr = 0;
        this.osrCount = 32; // bits shifted out; starts "empty" so autopull refills immediately
        this.isrCount = 0;

        this.txFifo = [];
        this.rxFifo = [];

        this.clock = 0;
        this.delay = 0;

        this.pins = 0;
        this.inputs = 0;
        // 2-FF input synchronizer stages — what the PIO sees lags `inputs` by
        // two clocks on bits where INPUT_SYNC_BYPASS=0. ff2 is the value PIO
        // reads this cycle; ff1 is the intermediate latch.
        this.inputsFf1 = 0;
        this.inputsFf2 = 0;
        this.pindirs = 0; // 1=out, 0=in
        this.outBase = 0;
        this.setBase = 0;
        this.sidesetBase = 0;
        this.inBase = 0;
        this.jmpPin = 0;
        this.setCount = 5;

        this.inShiftDir = 'right';
        this.outShiftDir = 'right';
        this.autoPush = false;
        this.autoPull = false;
        this.pushThresh = 32;
        this.pullThresh = 32;
        this.statusSel = 0; // 0 = TX FIFO level, 1 = RX FIFO level
        this.statusN = 0;

        // sidesetCount, instructions, wrapTarget, wrap are owned by loadProgram — do not reset here.

        this.history = [];
        this.irq = 0;
        this.irqPrev = 0;
        this.irqNext = 0;
        this.irqWaitStalled = false; // sticky while an IRQ wait is stalling
        this.irqWaitPc = -1;
        this.status = 'stopped';
        this.error = null;
    }

    loadProgram(programData) {
        this.instructions = programData.instructions;
        this.wrapTarget = programData.wrapTarget;
        this.wrap = programData.wrap;
        if (programData.sidesetCount !== undefined) {
            this.sidesetCount = programData.sidesetCount;
        }
        this.sidesetOpt = programData.sidesetOpt || false;
        this.sidesetPindirs = programData.sidesetPindirs || false;
        if (programData.setCount !== undefined) {
            this.setCount = programData.setCount;
        }
        this.reset();
    }

    // What the PIO state machine observes on `pin` this cycle. Output pins
    // read back the driven value directly; input pins go through the 2-FF
    // synchronizer unless their INPUT_SYNC_BYPASS bit is set.
    getPinState(pin) {
        pin = pin & 0x1F;
        const isOut = (this.pindirs >> pin) & 1;
        if (isOut) {
            return (this.pins >> pin) & 1;
        }
        const bypass = (this.inputSyncBypass >> pin) & 1;
        const source = bypass ? this.inputs : this.inputsFf2;
        return (source >> pin) & 1;
    }

    getAllPinStates() {
        return (this.pins & this.pindirs) | (this.inputs & ~this.pindirs);
    }

    pushTx(value) {
        if (this.txFifo.length < 4) {
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

    // Threshold 0 is interpreted as 32 per RP2040/RP2350 PIO datasheet.
    effPushThresh() {
        return this.pushThresh === 0 ? 32 : this.pushThresh;
    }

    effPullThresh() {
        return this.pullThresh === 0 ? 32 : this.pullThresh;
    }

    step() {
        if (this.error) return;

        if (this.instructions.length === 0) return;

        this.history.push({
            clock: this.clock,
            pins: this.pins,
            pc: this.pc,
            x: this.x,
            y: this.y,
            osr: this.osr,
            osrCount: this.osrCount,
            isr: this.isr,
            isrCount: this.isrCount
        });

        // Advance the input synchronizer on every PIO clock — including delay
        // and stall cycles. Reads later in this step see the new ff2.
        this.inputsFf2 = this.inputsFf1 >>> 0;
        this.inputsFf1 = this.inputs >>> 0;

        // Autopush/Autopull are evaluated before the instruction starts.
        // If a FIFO is full/empty respectively, the machine stalls on this cycle.
        let stalled = false;
        if (this.autoPush && this.isrCount >= this.effPushThresh()) {
            if (this.rxFifo.length < 4) {
                this.rxFifo.push(this.isr);
                this.isr = 0;
                this.isrCount = 0;
            } else {
                stalled = true;
            }
        }

        if (this.autoPull && this.osrCount >= this.effPullThresh()) {
            if (this.txFifo.length > 0) {
                this.osr = this.txFifo.shift();
                this.osrCount = 0;
            } else {
                stalled = true;
            }
        }

        if (stalled) {
            this.status = 'stalled';
            this.clock++;
            return;
        }

        if (this.delay > 0) {
            this.delay--;
            this.clock++;
            return;
        }

        if (this.pc >= this.instructions.length) {
            this.pc = 0;
        }

        const instr = this.instructions[this.pc];
        if (!instr) {
            this.error = `Instruction at PC ${this.pc} is undefined.`;
            this.status = 'error';
            return;
        }

        let sideSetVal = instr.sideSet;
        let applySideSet;

        if (this.sidesetOpt) {
            applySideSet = sideSetVal !== null && sideSetVal !== undefined;
        } else {
            applySideSet = true;
            if (sideSetVal === null || sideSetVal === undefined) {
                sideSetVal = 0;
            }
        }

        if (applySideSet && this.status !== 'stalled') {
            const val = sideSetVal;
            for (let i = 0; i < this.sidesetCount; i++) {
                const pin = (this.sidesetBase + i) % 32;
                const bit = (val >> i) & 1;

                if (this.sidesetPindirs) {
                    if (bit) {
                        this.pindirs |= (1 << pin);
                    } else {
                        this.pindirs &= ~(1 << pin);
                    }
                    this.pindirs = this.pindirs >>> 0;
                } else {
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                    this.pins = this.pins >>> 0;
                }
            }
        }

        let nextPc = this.pc + 1;
        let executed = true;
        let jumped = false;         // PC explicitly changed by JMP
        this.pcOverride = null;     // PC explicitly written by MOV/OUT dest=PC

        try {
            switch (instr.type) {
                case 'JMP': {
                    const jmpTarget = this.executeJmp(instr, nextPc);
                    if (jmpTarget !== nextPc) {
                        jumped = true;
                    }
                    nextPc = jmpTarget;
                    break;
                }
                case 'WAIT':
                    executed = this.executeWait(instr);
                    if (!executed) nextPc = this.pc;
                    break;
                case 'IN':
                    executed = this.executeIn(instr);
                    if (!executed) nextPc = this.pc;
                    break;
                case 'OUT':
                    executed = this.executeOut(instr);
                    if (!executed) nextPc = this.pc;
                    break;
                case 'PUSH':
                    executed = this.executePush(instr);
                    if (!executed) nextPc = this.pc;
                    break;
                case 'PULL':
                    executed = this.executePull(instr);
                    if (!executed) nextPc = this.pc;
                    break;
                case 'MOV':
                    this.executeMov(instr);
                    break;
                case 'IRQ':
                    executed = this.executeIrq(instr);
                    if (!executed) nextPc = this.pc;
                    break;
                case 'SET':
                    this.executeSet(instr);
                    break;
            }
        } catch (e) {
            this.error = e.message;
            this.status = 'error';
            return;
        }

        if (executed) {
            this.status = 'running';

            // Delay only applies after a successful (non-stalled) execution.
            if (instr.delay > 0) {
                this.delay = instr.delay;
            }

            if (this.pcOverride !== null) {
                // MOV/OUT dest=PC: take override, skip wrap.
                this.pc = this.pcOverride >>> 0;
            } else if (jumped) {
                // Per datasheet, wrap does not apply to JMP targets.
                this.pc = nextPc;
            } else {
                if (nextPc > this.wrap) {
                    nextPc = this.wrapTarget;
                }
                this.pc = nextPc;
            }
        } else {
            this.status = 'stalled';
        }

        this.clock++;
    }

    executeJmp(instr, nextPc) {
        let conditionMet = false;
        switch (instr.cond) {
            case '': conditionMet = true; break;
            case '!x': conditionMet = (this.x === 0); break;
            case 'x--': 
                conditionMet = (this.x !== 0);
                this.x = (this.x - 1) >>> 0;
                break;
            case '!y': conditionMet = (this.y === 0); break;
            case 'y--':
                conditionMet = (this.y !== 0);
                this.y = (this.y - 1) >>> 0;
                break;
            case 'x!=y': conditionMet = (this.x !== this.y); break;
            case 'pin': conditionMet = (this.getPinState(this.jmpPin) === 1); break;
            case '!osre': conditionMet = (this.osrCount < this.effPullThresh()); break; // OSR not empty
        }

        if (conditionMet) {
            return instr.target;
        }
        return nextPc;
    }

    executeWait(instr) {
        let val = 0;
        if (instr.source === 'gpio') {
            const pin = parseInt(instr.index);
            val = this.getPinState(pin);
        } else if (instr.source === 'pin') {
            const index = parseInt(instr.index);
            const pin = (this.inBase + index) & 0x1F;
            val = this.getPinState(pin);
        } else if (instr.source === 'jmppin') {
            const offset = parseInt(instr.index) || 0;
            const pin = (this.jmpPin + offset) & 0x1F;
            val = this.getPinState(pin);
        } else if (instr.source === 'irq') {
            let index = parseInt(instr.index) & 7;

            if (instr.prev) val = (this.irqPrev >> index) & 1;
            else if (instr.next) val = (this.irqNext >> index) & 1;
            else val = (this.irq >> index) & 1;

            // WAIT 1 IRQ auto-clears the flag once observed high.
            if (instr.polarity === 1 && val === 1) {
                if (instr.prev) this.irqPrev &= ~(1 << index);
                else if (instr.next) this.irqNext &= ~(1 << index);
                else this.irq &= ~(1 << index);
            }
        }

        return val === instr.polarity;
    }

    executeIn(instr) {
        let val = 0;
        if (instr.source === 'pins') {
            // Construct via per-pin wrap at 32 — IN_BASE + i may exceed 31.
            for (let i = 0; i < 32; i++) {
                const pin = (this.inBase + i) & 0x1F;
                if (this.getPinState(pin)) {
                    val |= (1 << i);
                }
            }
        } else if (instr.source === 'x') {
            val = this.x;
        } else if (instr.source === 'y') {
            val = this.y;
        } else if (instr.source === 'null') {
            val = 0;
        } else if (instr.source === 'isr') {
            val = this.isr;
        } else if (instr.source === 'osr') {
            val = this.osr;
        } else if (instr.source === 'status') {
            const level = this.statusSel === 1
                ? this.rxFifo.length
                : this.txFifo.length;
            val = level < this.statusN ? 0xFFFFFFFF : 0;
        }

        const bitCount = instr.bitCount;
        const mask = bitCount === 32 ? 0xFFFFFFFF : (1 << bitCount) - 1;
        const data = val & mask;
        
        let newIsr = this.isr;
        if (this.inShiftDir === 'right') {
            // Right shift: new data enters MSB.
            if (bitCount === 32) {
                newIsr = data;
            } else {
                newIsr = (this.isr >>> bitCount) | (data << (32 - bitCount));
            }
        } else {
            // Left shift: new data enters LSB.
            if (bitCount === 32) {
                newIsr = data;
            } else {
                newIsr = (this.isr << bitCount) | data;
            }
        }
        newIsr = newIsr >>> 0;

        let newIsrCount = this.isrCount + bitCount;
        if (newIsrCount > 32) newIsrCount = 32;

        this.isr = newIsr;
        this.isrCount = newIsrCount;
        return true;
    }

    executeOut(instr) {
        const bitCount = instr.bitCount;
        const mask = bitCount === 32 ? 0xFFFFFFFF : (1 << bitCount) - 1;

        let data = 0;

        if (this.outShiftDir === 'right') {
            data = this.osr & mask;
            if (bitCount === 32) {
                this.osr = 0;
            } else {
                this.osr = this.osr >>> bitCount;
            }
        } else {
            if (bitCount === 32) {
                data = this.osr;
                this.osr = 0;
            } else {
                data = (this.osr >>> (32 - bitCount)) & mask;
                this.osr = (this.osr << bitCount) >>> 0;
            }
        }

        this.osrCount += bitCount;
        if (this.osrCount > 32) this.osrCount = 32;

        switch (instr.dest) {
            case 'pins':
                for (let i = 0; i < bitCount; i++) {
                    const pin = (this.outBase + i) % 32;
                    const bit = (data >> i) & 1;
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                }
                this.pins = this.pins >>> 0;
                break;
            case 'x': this.x = data; break;
            case 'y': this.y = data; break;
            case 'null': break;
            case 'pindirs':
                for (let i = 0; i < bitCount; i++) {
                    const pin = (this.outBase + i) % 32;
                    const bit = (data >> i) & 1;
                    if (bit) {
                        this.pindirs |= (1 << pin);
                    } else {
                        this.pindirs &= ~(1 << pin);
                    }
                }
                this.pindirs = this.pindirs >>> 0;
                break;
            case 'pc':
                this.pcOverride = data;
                return true;
            case 'isr': {
                this.isr = data >>> 0;
                this.isrCount = bitCount;
                if (this.isrCount > 32) this.isrCount = 32;
                break;
            }
            case 'exec':
                // TODO: not implemented
                break;
        }
        return true;
    }

    executePush(instr) {
        // With autopush enabled, an explicit PUSH below threshold is a no-op
        // — autopush would have already pushed if the threshold were reached.
        if (this.autoPush && this.isrCount < this.effPushThresh()) {
            return true;
        }

        if (instr.iffull && this.isrCount < this.effPushThresh()) {
            return true;
        }

        if (this.rxFifo.length >= 4) {
            if (instr.block) {
                return false;
            } else {
                this.isr = 0;
                this.isrCount = 0;
                return true;
            }
        }

        this.rxFifo.push(this.isr);
        this.isr = 0;
        this.isrCount = 0;
        return true;
    }

    executePull(instr) {
        // With autopull enabled, an explicit PULL while OSR still has data is
        // a no-op — autopull refills otherwise.
        if (this.autoPull && this.osrCount < this.effPullThresh()) {
            return true;
        }

        if (instr.ifempty && this.osrCount < this.effPullThresh()) {
            return true;
        }

        if (this.txFifo.length === 0) {
            if (instr.block) {
                return false;
            } else {
                // noblock with empty FIFO: copy X to OSR.
                this.osr = this.x;
                this.osrCount = 0;
                return true;
            }
        }

        this.osr = this.txFifo.shift();
        this.osrCount = 0;
        return true;
    }

    executeMov(instr) {
        let val = 0;
        switch (instr.src) {
            case 'pins': {
                val = 0;
                for (let i = 0; i < 32; i++) {
                    const pin = (this.inBase + i) & 0x1F;
                    if (this.getPinState(pin)) {
                        val |= (1 << i);
                    }
                }
                val = val >>> 0;
                break;
            }
            case 'x': val = this.x; break;
            case 'y': val = this.y; break;
            case 'null': val = 0; break;
            case 'status': {
                // MOV STATUS: all-ones if selected FIFO level < STATUS_N, else all-zeros.
                const level = this.statusSel === 1
                    ? this.rxFifo.length
                    : this.txFifo.length;
                val = level < this.statusN ? 0xFFFFFFFF : 0;
                break;
            }
            case 'isr': val = this.isr; break;
            case 'osr': val = this.osr; break;
            case 'rxfifo[y]': {
                const idx = this.y & 3;
                val = this.rxFifo[idx] || 0;
                break;
            }
        }

        if (instr.op === 'invert' || instr.op === '~' || instr.op === '!') {
            val = ~val;
        } else if (instr.op === 'reverse' || instr.op === '::') {
            val = this.reverseBits(val);
        }

        val = val >>> 0;

        switch (instr.dest) {
            case 'pins': {
                for (let i = 0; i < 32; i++) {
                    const pin = (this.outBase + i) % 32;
                    const bit = (val >> i) & 1;
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                }
                this.pins = this.pins >>> 0;
                break;
            }
            case 'x': this.x = val; break;
            case 'y': this.y = val; break;
            case 'exec': break; // TODO: not implemented
            case 'pc': this.pcOverride = val; break;
            case 'isr': this.isr = val; this.isrCount = 0; break;
            case 'osr': this.osr = val; this.osrCount = 0; break;
            case 'rxfifo[y]': {
                const idx = this.y & 3;
                this.rxFifo[idx] = val;
                break;
            }
        }
    }
    
    reverseBits(n) {
        n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
        n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
        n = ((n >>> 4) & 0x0F0F0F0F) | ((n & 0x0F0F0F0F) << 4);
        n = ((n >>> 8) & 0x00FF00FF) | ((n & 0x00FF00FF) << 8);
        return ((n >>> 16) | (n << 16)) >>> 0;
    }

    executeIrq(instr) {
        let index = instr.index & 7;

        if (instr.clear) {
            if (instr.prev) this.irqPrev &= ~(1 << index);
            else if (instr.next) this.irqNext &= ~(1 << index);
            else this.irq &= ~(1 << index);
            this.irqWaitStalled = false;
            this.irqWaitPc = -1;
            return true;
        }

        const continuingSameWait = this.irqWaitStalled && this.irqWaitPc === this.pc;

        // Assert the flag only on the first cycle. During a wait stall the SM
        // re-executes the IRQ op every cycle, so re-asserting would defeat any
        // external clear that is meant to unstick this wait.
        if (!continuingSameWait) {
            if (instr.prev) this.irqPrev |= (1 << index);
            else if (instr.next) this.irqNext |= (1 << index);
            else this.irq |= (1 << index);
        }

        if (instr.wait) {
            let irqVal = 0;
            if (instr.prev) irqVal = (this.irqPrev >> index) & 1;
            else if (instr.next) irqVal = (this.irqNext >> index) & 1;
            else irqVal = (this.irq >> index) & 1;
            
            if (irqVal) {
                this.irqWaitStalled = true;
                this.irqWaitPc = this.pc;
                return false;
            }
        }
        this.irqWaitStalled = false;
        this.irqWaitPc = -1;
        return true;
    }

    executeSet(instr) {
        const val = instr.value & 0x1F;
        switch (instr.dest) {
            case 'pins':
                for (let i = 0; i < this.setCount; i++) {
                    const pin = (this.setBase + i) % 32;
                    const bit = (val >> i) & 1;
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                }
                this.pins = this.pins >>> 0;
                break;
            case 'x': this.x = val; break;
            case 'y': this.y = val; break;
            case 'pindirs':
                for (let i = 0; i < this.setCount; i++) {
                    const pin = (this.setBase + i) % 32;
                    const bit = (val >> i) & 1;
                    if (bit) {
                        this.pindirs |= (1 << pin);
                    } else {
                        this.pindirs &= ~(1 << pin);
                    }
                }
                this.pindirs = this.pindirs >>> 0;
                break;
        }
    }
}
