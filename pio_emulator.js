class PioEmulator {
    constructor() {
        this.instructions = [];
        this.wrapTarget = 0;
        this.wrap = 0;
        this.reset();
    }

    reset() {
        this.pc = 0;
        this.x = 0;
        this.y = 0;
        this.osr = 0;
        this.isr = 0;
        this.osrCount = 0; // Number of bits shifted out
        this.isrCount = 0; // Number of bits shifted in
        
        this.txFifo = [];
        this.rxFifo = [];
        
        this.clock = 0;
        this.delay = 0; // Cycles to wait
        
        this.pins = 0; // 32-bit GPIO state (Output latch)
        this.inputs = 0; // 32-bit GPIO input state (External signals)
        this.pindirs = 0; // 32-bit GPIO direction (1=out, 0=in)
        this.outBase = 0;
        this.setBase = 0;
        this.sidesetBase = 0;
        this.inBase = 0;
        this.jmpPin = 0;
        // this.sidesetCount = 5; // Do not reset sidesetCount here, it is set by loadProgram
        this.setCount = 5; // Default SET count
        
        this.inShiftDir = 'right'; // 'right' or 'left'
        this.outShiftDir = 'right'; // 'right' or 'left'
        this.autoPush = false;
        this.autoPull = false;
        this.pushThresh = 32;
        this.pullThresh = 32;
        
        // Do not clear instructions here, as reset() is called after loadProgram
        // this.instructions = [];
        // this.wrapTarget = 0;
        // this.wrap = 0;
        
        this.history = []; // For timing chart: { clock, pins }
        this.irq = 0; // 8-bit IRQ flags
        this.status = 'stopped'; // running, stopped, stalled
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

    getPinState(pin) {
        pin = pin & 0x1F;
        const isOut = (this.pindirs >> pin) & 1;
        if (isOut) {
            return (this.pins >> pin) & 1;
        } else {
            return (this.inputs >> pin) & 1;
        }
    }

    getAllPinStates() {
        // Combine outputs and inputs based on direction
        return (this.pins & this.pindirs) | (this.inputs & ~this.pindirs);
    }

    pushTx(value) {
        if (this.txFifo.length < 4) {
            this.txFifo.push(value >>> 0); // Ensure unsigned 32-bit
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

    step() {
        if (this.error) return;

        if (this.instructions.length === 0) return;

        // Record history
        this.history.push({
            clock: this.clock,
            pins: this.pins
        });

        // Handle delay
        if (this.delay > 0) {
            this.delay--;
            this.clock++;
            return;
        }

        if (this.pc >= this.instructions.length) {
            this.pc = 0; // Should not happen with wrap, but safety
        }

        const instr = this.instructions[this.pc];
        if (!instr) {
            this.error = `Instruction at PC ${this.pc} is undefined.`;
            this.status = 'error';
            return;
        }

        // Execute Side-set
        let sideSetVal = instr.sideSet;
        let applySideSet = false;

        if (this.sidesetOpt) {
            // Rule 3 (Side-Set): Optional
            // Only apply if specified in the instruction.
            if (sideSetVal !== null && sideSetVal !== undefined) {
                applySideSet = true;
            }
        } else {
            // Rule 3 (Side-Set): Mandatory
            // Always apply. If not specified, default to 0.
            applySideSet = true;
            if (sideSetVal === null || sideSetVal === undefined) {
                sideSetVal = 0;
            }
        }

        if (applySideSet) {
            const val = sideSetVal;
            for (let i = 0; i < this.sidesetCount; i++) {
                const pin = (this.sidesetBase + i) % 32; // Rule 1: Wrap at 32
                const bit = (val >> i) & 1;
                
                if (this.sidesetPindirs) {
                    // Affects pindirs
                    if (bit) {
                        this.pindirs |= (1 << pin);
                    } else {
                        this.pindirs &= ~(1 << pin);
                    }
                    this.pindirs = this.pindirs >>> 0; // Rule 3: Integer Safety
                } else {
                    // Affects pins
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                    this.pins = this.pins >>> 0; // Rule 3: Integer Safety
                }
            }
        }

        let nextPc = this.pc + 1;
        let executed = true;

        // Set delay if present
        if (instr.delay > 0) {
            this.delay = instr.delay;
        }

        try {
            switch (instr.type) {
                case 'JMP':
                    nextPc = this.executeJmp(instr, nextPc);
                    break;
                case 'WAIT':
                    executed = this.executeWait(instr);
                    if (!executed) nextPc = this.pc; // Stay on same instruction
                    break;
                case 'IN':
                    executed = this.executeIn(instr);
                    if (!executed) nextPc = this.pc; // Stall
                    break;
                case 'OUT':
                    executed = this.executeOut(instr);
                    if (!executed) nextPc = this.pc; // Stall
                    break;
                case 'PUSH':
                    executed = this.executePush(instr);
                    if (!executed) nextPc = this.pc; // Stall
                    break;
                case 'PULL':
                    executed = this.executePull(instr);
                    if (!executed) nextPc = this.pc; // Stall
                    break;
                case 'MOV':
                    this.executeMov(instr);
                    break;
                case 'IRQ':
                    this.executeIrq(instr);
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
            // Handle wrap
            if (nextPc > this.wrap) {
                nextPc = this.wrapTarget;
            }
            this.pc = nextPc;
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
                if (this.x !== 0) {
                    conditionMet = true;
                    this.x = (this.x - 1) >>> 0;
                }
                break;
            case '!y': conditionMet = (this.y === 0); break;
            case 'y--':
                if (this.y !== 0) {
                    conditionMet = true;
                    this.y = (this.y - 1) >>> 0;
                }
                break;
            case 'x!=y': conditionMet = (this.x !== this.y); break;
            case 'pin': conditionMet = (this.getPinState(this.jmpPin) === 1); break;
            case '!osre': conditionMet = (this.osrCount < this.pullThresh); break; // OSR not empty (count < threshold)
        }

        if (conditionMet) {
            return instr.target;
        }
        return nextPc;
    }

    executeWait(instr) {
        // wait 1 gpio 15
        let val = 0;
        if (instr.source === 'gpio') {
            // Read from pins (output or input simulation)
            const pin = parseInt(instr.index);
            val = this.getPinState(pin);
        } else if (instr.source === 'pin') {
            // wait 1 pin 0 -> wait for IN_BASE + 0
            const index = parseInt(instr.index);
            const pin = (this.inBase + index) & 0x1F; // Wrap 32
            val = this.getPinState(pin);
        } else if (instr.source === 'irq') {
            // wait 1 irq 2
            const index = parseInt(instr.index) & 7;
            val = (this.irq >> index) & 1;
            
            // "irq" source for WAIT usually clears the flag if polarity is 1?
            // Docs: "wait 1 irq 2" -> Wait for IRQ 2 to be 1.
            if (instr.polarity === 1 && val === 1) {
                this.irq &= ~(1 << index); // Auto clear
            }
        }
        // TODO: Implement other wait sources (pin)

        return val === instr.polarity;
    }

    executeIn(instr) {
        // in source, bit_count
        let val = 0;
        if (instr.source === 'pins') {
            // Use inBase
            // val = this.pins >>> this.inBase; // Old: only read output latch
            
            // New: Read actual pin states
            const allPins = this.getAllPinStates();
            val = allPins >>> this.inBase;
            
            // Handle wrap if needed (though >>> handles shift, we might need to wrap around if inBase + bitCount > 32)
            // But standard behavior for 'pins' source is just shifting.
            // Wait, if inBase is 30 and we read 3 bits, do we get pin 30, 31, 0?
            // RP2040 PIO: "The state of the pins is shifted into the ISR... The least significant bit of the data is the state of the pin specified by IN_BASE."
            // It doesn't explicitly say it wraps for IN source, but usually pin mappings wrap.
            // However, simple shift is likely sufficient for now unless we need perfect wrap emulation for IN PINS.
            // Actually, let's implement wrap correctly for IN PINS just in case.
            
            let constructedVal = 0;
            for(let i=0; i<32; i++) {
                const pin = (this.inBase + i) & 0x1F;
                if (this.getPinState(pin)) {
                    constructedVal |= (1 << i);
                }
            }
            val = constructedVal;
            
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
        }

        const bitCount = instr.bitCount;
        const mask = bitCount === 32 ? 0xFFFFFFFF : (1 << bitCount) - 1;
        const data = val & mask;
        
        let newIsr = this.isr;
        if (this.inShiftDir === 'right') {
            // Right Shift: New data to MSB
            if (bitCount === 32) {
                newIsr = data;
            } else {
                newIsr = (this.isr >>> bitCount) | (data << (32 - bitCount));
            }
        } else {
            // Left Shift: New data to LSB
            if (bitCount === 32) {
                newIsr = data;
            } else {
                newIsr = (this.isr << bitCount) | data;
            }
        }
        newIsr = newIsr >>> 0;
        
        let newIsrCount = this.isrCount + bitCount;
        if (newIsrCount > 32) newIsrCount = 32;
        
        // Auto-push logic
        if (this.autoPush && newIsrCount >= this.pushThresh) {
            if (this.rxFifo.length < 4) {
                this.rxFifo.push(newIsr);
                this.isr = 0;
                this.isrCount = 0;
                return true;
            } else {
                return false; // Stall
            }
        }
        
        this.isr = newIsr;
        this.isrCount = newIsrCount;
        return true;
    }

    executeOut(instr) {
        // out dest, bit_count
        
        // Auto-pull logic
        if (this.autoPull && this.osrCount >= this.pullThresh) {
            if (this.txFifo.length > 0) {
                this.osr = this.txFifo.shift();
                this.osrCount = 0;
            } else {
                return false; // Stall
            }
        }

        const bitCount = instr.bitCount;
        const mask = bitCount === 32 ? 0xFFFFFFFF : (1 << bitCount) - 1;
        
        let data = 0;
        
        if (this.outShiftDir === 'right') {
            // Shift Right: Take from LSB
            data = this.osr & mask;
            if (bitCount === 32) {
                this.osr = 0;
            } else {
                this.osr = this.osr >>> bitCount;
            }
        } else {
            // Shift Left: Take from MSB
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
                    const pin = (this.outBase + i) % 32; // Rule 1: Wrap at 32
                    const bit = (data >> i) & 1;
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                }
                this.pins = this.pins >>> 0; // Rule 3: Integer Safety
                break;
            case 'x': this.x = data; break;
            case 'y': this.y = data; break;
            case 'null': break; // discard
            case 'pindirs':
                for (let i = 0; i < bitCount; i++) {
                    const pin = (this.outBase + i) % 32; // Rule 1: Wrap at 32
                    const bit = (data >> i) & 1;
                    if (bit) {
                        this.pindirs |= (1 << pin);
                    } else {
                        this.pindirs &= ~(1 << pin);
                    }
                }
                this.pindirs = this.pindirs >>> 0; // Rule 3: Integer Safety
                break;
            case 'pc': 
                this.pc = data - 1; 
                return true;
            case 'isr':
                // OUT to ISR: Shift into ISR respecting inShiftDir
                let newIsr = this.isr;
                if (this.inShiftDir === 'right') {
                    if (bitCount === 32) {
                        newIsr = data;
                    } else {
                        newIsr = (this.isr >>> bitCount) | (data << (32 - bitCount));
                    }
                } else {
                    if (bitCount === 32) {
                        newIsr = data;
                    } else {
                        newIsr = (this.isr << bitCount) | data;
                    }
                }
                this.isr = newIsr >>> 0;
                this.isrCount += bitCount;
                if (this.isrCount > 32) this.isrCount = 32;
                break;
            case 'exec':
                // Not implemented
                break;
        }
        return true;
    }

    executePush(instr) {
        // push (iffull) (block/noblock)
        
        if (instr.ifull && this.isrCount < this.pushThresh) {
            return true; // NOP
        }
        
        if (this.rxFifo.length >= 4) {
            if (instr.block) {
                return false; // Stall
            } else {
                // noblock
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
        // pull (ifempty) (block/noblock)
        
        if (instr.ifempty && this.osrCount < this.pullThresh) {

            return true; // NOP
        }

        if (this.txFifo.length === 0) {
            if (instr.block) {
                return false; // Stall
            } else {
                // noblock: Copy X to OSR
                this.osr = this.x;
                this.osrCount = 0; // Reset count
                return true;
            }
        }

        this.osr = this.txFifo.shift();
        this.osrCount = 0; // Reset count
        return true;
    }

    executeMov(instr) {
        // mov dest, (op) src
        let val = 0;
        switch (instr.src) {
            case 'pins': val = this.pins; break;
            case 'x': val = this.x; break;
            case 'y': val = this.y; break;
            case 'null': val = 0; break;
            case 'status': 
                // Rule 4: MOV STATUS
                if (this.txFifo.length < 4) {
                    val = 0xFFFFFFFF;
                } else {
                    val = 0;
                }
                break;
            case 'isr': val = this.isr; break;
            case 'osr': val = this.osr; break;
        }
        
        // Operations
        if (instr.op === 'invert' || instr.op === '~' || instr.op === '!') {
            val = ~val;
        } else if (instr.op === 'reverse' || instr.op === '::') {
            // Bit reverse 32-bit
            val = this.reverseBits(val);
        }

        val = val >>> 0; // unsigned 32

        switch (instr.dest) {
            case 'pins': this.pins = val; break;
            case 'x': this.x = val; break;
            case 'y': this.y = val; break;
            case 'exec': break; // TODO
            case 'pc': this.pc = val - 1; break;
            case 'isr': this.isr = val; this.isrCount = 0; break; // Reset count to 0
            case 'osr': this.osr = val; this.osrCount = 0; break; // Reset count to 0
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
        const index = instr.index & 7; // 0-7
        
        if (instr.clear) {
            this.irq &= ~(1 << index);
        } else {
            // Set
            this.irq |= (1 << index);
            
            if (instr.wait) {
                if ((this.irq >> index) & 1) {
                    return false; // Stall
                }
            }
        }
        return true;
    }

    executeSet(instr) {
        // set dest, value
        const val = instr.value;
        switch (instr.dest) {
            case 'pins':
                for (let i = 0; i < this.setCount; i++) {
                    const pin = (this.setBase + i) % 32; // Rule 1: Wrap at 32
                    const bit = (val >> i) & 1;
                    if (bit) {
                        this.pins |= (1 << pin);
                    } else {
                        this.pins &= ~(1 << pin);
                    }
                }
                this.pins = this.pins >>> 0; // Rule 3: Integer Safety
                break;
            case 'x': this.x = val; break;
            case 'y': this.y = val; break;
            case 'pindirs':
                for (let i = 0; i < this.setCount; i++) {
                    const pin = (this.setBase + i) % 32; // Rule 1: Wrap at 32
                    const bit = (val >> i) & 1;
                    if (bit) {
                        this.pindirs |= (1 << pin);
                    } else {
                        this.pindirs &= ~(1 << pin);
                    }
                }
                this.pindirs = this.pindirs >>> 0; // Rule 3: Integer Safety
                break;
        }
    }
}
