class PioAssembler {
    constructor() {
        this.labels = {};
        this.defines = {};
        this.origin = null;
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
        this.defines = {};
        this.origin = null;
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
            defines: this.defines,
            origin: this.origin,
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
            case '.define':
                // .define name value  — defines a named constant
                if (parts.length >= 3) {
                    const name = parts[1];
                    let val = parts[2];
                    // Support expressions referencing other defines
                    if (val in this.defines) {
                        this.defines[name] = this.defines[val];
                    } else {
                        this.defines[name] = parseInt(val);
                    }
                }
                break;
            case '.origin':
                // .origin N — set program origin offset
                if (parts.length >= 2) {
                    this.origin = parseInt(parts[1]);
                }
                break;
        }
    }

    resolveValue(str) {
        if (str in this.defines) return this.defines[str];
        if (str in this.labels) return this.labels[str];
        return parseInt(str);
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
        // syntax: wait polarity {gpio|pin|irq|jmppin} index [rel]
        // For irq: wait polarity irq index [rel]
        // For jmppin (RP2350): wait polarity jmppin [count]
        const polarity = this.resolveValue(args[0]);
        const source = args[1];
        let index = null;
        let rel = false;

        if (source === 'jmppin') {
            // RP2350: WAIT JMPPIN — optional count argument
            index = args.length > 2 ? this.resolveValue(args[2]) : 0;
        } else if (source === 'irq') {
            // Parse index and optional rel
            for (let i = 2; i < args.length; i++) {
                if (args[i] === 'rel') {
                    rel = true;
                } else {
                    index = this.resolveValue(args[i]);
                }
            }
        } else {
            index = this.resolveValue(args[2]);
        }

        return { type: 'WAIT', polarity, source, index, rel };
    }

    parseIn(args) {
        const source = args[0];
        const bitCount = this.resolveValue(args[1]);
        return { type: 'IN', source, bitCount };
    }

    parseOut(args) {
        const dest = args[0];
        const bitCount = this.resolveValue(args[1]);
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
        // syntax: irq [clear|wait|set] index [rel]   e.g. irq 0 / irq clear 0
        // RP2350 also supports: irq [prev|next] index
        let clear = false;
        let wait = false;
        let rel = false;
        let prev = false;
        let next = false;
        let indexStr = '';

        for (let arg of args) {
            if (arg === 'clear') clear = true;
            else if (arg === 'wait') wait = true;
            else if (arg === 'set') { /* default behavior, no flag needed */ }
            else if (arg === 'rel') rel = true;
            else if (arg === 'prev') prev = true;
            else if (arg === 'next') next = true;
            else indexStr = arg;
        }

        // RP2350: prev/next imply rel-like behavior
        if (prev || next) rel = true;

        const index = this.resolveValue(indexStr);
        return { type: 'IRQ', clear, wait, rel, prev, next, index };
    }

    parseSet(args) {
        const dest = args[0];
        const value = this.resolveValue(args[1]);
        return { type: 'SET', dest, value };
    }
}
