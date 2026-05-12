class PioAssembler {
    constructor() {
        this.labels = {};
        this.instructions = [];
        this.programName = "program";
        this.wrapTarget = 0;
        this.wrap = 0;
        this.sidesetCount = 0;
        this.sidesetOpt = false;
        this.sidesetPindirs = false;
    }

    assemble(sourceCode) {
        this.labels = {};
        this.instructions = [];
        this.wrapTarget = -1;
        this.wrap = -1;
        this.sidesetCount = 0;
        this.sidesetOpt = false;
        this.sidesetPindirs = false;
        
        const lines = sourceCode.split('\n');
        let pc = 0;

        // First pass: collect labels and directives
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            const commentIndex = line.indexOf(';');
            if (commentIndex !== -1) {
                line = line.substring(0, commentIndex).trim();
            }
            if (line === '') continue;

            const colonIndex = line.indexOf(':');
            if (colonIndex !== -1) {
                const labelName = line.substring(0, colonIndex).trim();
                this.labels[labelName] = pc;
                line = line.substring(colonIndex + 1).trim();
            }

            if (line === '') continue;

            if (line.startsWith('.')) {
                this.handleDirective(line, pc);
            } else {
                pc++;
            }
        }

        // Default wrap points if not specified
        if (this.wrap === -1) this.wrap = pc - 1;
        if (this.wrapTarget === -1) this.wrapTarget = 0;

        // Second pass: generate instructions
        pc = 0;
        const programMap = [];
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            const commentIndex = line.indexOf(';');
            if (commentIndex !== -1) {
                line = line.substring(0, commentIndex).trim();
            }
            if (line === '') continue;

            const colonIndex = line.indexOf(':');
            if (colonIndex !== -1) {
                line = line.substring(colonIndex + 1).trim();
            }

            if (line === '') continue;
            if (line.startsWith('.')) continue;

            try {
                const instr = this.parseInstruction(line, pc);
                this.instructions.push(instr);
                programMap.push({
                    pc: pc,
                    line: i + 1,
                    text: lines[i] // original (with comments) for the program display
                });
                pc++;
            } catch (e) {
                throw new Error(`Line ${i + 1}: ${e.message}`);
            }
        }

        return {
            instructions: this.instructions,
            labels: this.labels,
            wrapTarget: this.wrapTarget,
            wrap: this.wrap,
            sidesetCount: this.sidesetCount,
            sidesetOpt: this.sidesetOpt,
            sidesetPindirs: this.sidesetPindirs,
            programMap: programMap
        };
    }

    handleDirective(line, pc) {
        const parts = line.split(/\s+/);
        const directive = parts[0];

        switch (directive) {
            case '.program':
                this.programName = parts[1];
                break;
            case '.wrap_target':
                this.wrapTarget = pc;
                break;
            case '.wrap':
                this.wrap = pc - 1;
                break;
            case '.side_set':
                // .side_set count [opt] [pindirs]
                this.sidesetCount = parseInt(parts[1]);
                if (parts.includes('opt')) this.sidesetOpt = true;
                if (parts.includes('pindirs')) this.sidesetPindirs = true;
                break;
            // TODO: .define, .origin, etc.
        }
    }

    parseInstruction(line, pc) {
        let sideSetVal = null;
        let delay = 0;

        const sideIndex = line.indexOf('side ');
        let mainPart = line;

        if (sideIndex !== -1) {
            const sidePart = line.substring(sideIndex + 5).trim();
            mainPart = line.substring(0, sideIndex).trim();

            // sidePart may also carry a delay, e.g. "side 1 [2]"
            const sideParts = sidePart.split(/\s+/);
            let valStr = sideParts[0];

            if (valStr.startsWith('0b')) {
                sideSetVal = parseInt(valStr.substring(2), 2);
            } else {
                sideSetVal = parseInt(valStr);
            }

            if (sideParts.length > 1) {
                const delayStr = sideParts[1];
                if (delayStr.startsWith('[') && delayStr.endsWith(']')) {
                    delay = parseInt(delayStr.substring(1, delayStr.length - 1));
                }
            }
        } else {
            const delayMatch = line.match(/\[(\d+)\]$/);
            if (delayMatch) {
                delay = parseInt(delayMatch[1]);
                mainPart = line.substring(0, line.lastIndexOf('[')).trim();
            }
        }

        const parts = mainPart.match(/([^\s,]+)/g);
        if (!parts) throw new Error("Empty instruction");

        const op = parts[0].toLowerCase();
        const args = parts.slice(1).map(s => s.replace(',', ''));

        let instr = null;
        switch (op) {
            case 'jmp': instr = this.parseJmp(args, pc); break;
            case 'wait': instr = this.parseWait(args); break;
            case 'in': instr = this.parseIn(args); break;
            case 'out': instr = this.parseOut(args); break;
            case 'push': instr = this.parsePush(args); break;
            case 'pull': instr = this.parsePull(args); break;
            case 'mov': instr = this.parseMov(args); break;
            case 'irq': instr = this.parseIrq(args); break;
            case 'set': instr = this.parseSet(args); break;
            case 'nop': instr = this.parseMov(['y', 'y']); break;
            default: throw new Error(`Unknown instruction: ${op}`);
        }
        
        instr.sideSet = sideSetVal;
        instr.delay = delay;
        return instr;
    }

    parseJmp(args, pc) {
        // syntax: jmp [cond] target
        let cond = '';
        let target = '';
        
        if (args.length === 1) {
            target = args[0];
        } else {
            cond = args[0];
            target = args[1];
        }

        let targetPc = 0;
        if (target in this.labels) {
            targetPc = this.labels[target];
        } else {
            targetPc = parseInt(target);
            if (isNaN(targetPc)) throw new Error(`Unknown label: ${target}`);
        }

        return { type: 'JMP', cond: cond, target: targetPc };
    }

    parseWait(args) {
        // syntax: wait polarity {gpio|pin|irq} index   e.g. wait 1 gpio 15
        const polarity = parseInt(args[0]);
        const source = args[1];
        const index = args[2]; // number, or 'rel' for irq
        return { type: 'WAIT', polarity, source, index };
    }

    parseIn(args) {
        const source = args[0];
        const bitCount = parseInt(args[1]);
        return { type: 'IN', source, bitCount };
    }

    parseOut(args) {
        const dest = args[0];
        const bitCount = parseInt(args[1]);
        return { type: 'OUT', dest, bitCount };
    }

    parsePush(args) {
        // syntax: push [iffull] [block|noblock]
        const ifull = args.includes('ifull');
        const block = !args.includes('noblock');
        return { type: 'PUSH', ifull, block };
    }

    parsePull(args) {
        // syntax: pull [ifempty] [block|noblock]
        const ifempty = args.includes('ifempty');
        const block = !args.includes('noblock');
        return { type: 'PULL', ifempty, block };
    }

    parseMov(args) {
        // syntax: mov dest, [op] src
        // The tokenizer splits on whitespace/commas, so an op fused to the src
        // ("~y") arrives as 2 args; a spaced op (":: y") arrives as 3.
        const dest = args[0];
        let src = '';
        let op = '';

        if (args.length === 2) {
            const s = args[1];
            if (s.startsWith('~') || s.startsWith('!')) {
                op = '~';
                src = s.substring(1);
            } else if (s.startsWith('::')) {
                op = '::';
                src = s.substring(2);
            } else {
                src = s;
            }
        } else if (args.length === 3) {
            op = args[1];
            src = args[2];
        }
        
        return { type: 'MOV', dest, src, op };
    }

    parseIrq(args) {
        // syntax: irq [clear|wait] index [rel]   e.g. irq 0 / irq clear 0
        let clear = false;
        let wait = false;
        let indexStr = '';

        for (let arg of args) {
            if (arg === 'clear') clear = true;
            else if (arg === 'wait') wait = true;
            else if (arg !== 'rel') indexStr = arg;
        }

        const index = parseInt(indexStr);
        return { type: 'IRQ', clear, wait, index };
    }

    parseSet(args) {
        const dest = args[0];
        const value = parseInt(args[1]);
        return { type: 'SET', dest, value };
    }
}
