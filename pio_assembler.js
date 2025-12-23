class PioAssembler {
    constructor() {
        this.labels = {};
        this.instructions = [];
        this.programName = "program";
        this.wrapTarget = 0;
        this.wrap = 0; // Default wrap is at the end
        this.sidesetCount = 0;
        this.sidesetOpt = false;
        this.sidesetPindirs = false;
    }

    assemble(sourceCode) {
        this.labels = {};
        this.instructions = [];
        this.wrapTarget = -1;
        this.wrap = -1;
        
        const lines = sourceCode.split('\n');
        let pc = 0;

        // First pass: collect labels and directives
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            // Remove comments
            const commentIndex = line.indexOf(';');
            if (commentIndex !== -1) {
                line = line.substring(0, commentIndex).trim();
            }
            if (line === '') continue;

            if (line.startsWith('.')) {
                this.handleDirective(line, pc);
            } else if (line.endsWith(':')) {
                const labelName = line.substring(0, line.length - 1).trim();
                this.labels[labelName] = pc;
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

            if (line.startsWith('.') || line.endsWith(':')) {
                continue;
            }

            try {
                const instr = this.parseInstruction(line, pc);
                this.instructions.push(instr);
                programMap.push({
                    pc: pc,
                    line: i + 1,
                    text: lines[i] // Keep original text including comments for display
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
                // Simplified side_set handling
                // .side_set count [opt] [pindirs]
                this.sidesetCount = parseInt(parts[1]);
                if (parts.includes('opt')) this.sidesetOpt = true;
                if (parts.includes('pindirs')) this.sidesetPindirs = true;
                break;
            // Add more directives as needed (.define, .origin etc.)
        }
    }

    parseInstruction(line, pc) {
        // Handle side-set if present (syntax: side X)
        let sideSetVal = null;
        let delay = 0;
        
        // Pre-processing to extract side set and delay
        // Look for "side" keyword
        const sideIndex = line.indexOf('side ');
        let mainPart = line;
        
        if (sideIndex !== -1) {
            const sidePart = line.substring(sideIndex + 5).trim();
            mainPart = line.substring(0, sideIndex).trim();
            
            // Parse side value (can be hex, binary, decimal)
            // sidePart might contain delay too? e.g. "side 1 [2]"
            const sideParts = sidePart.split(/\s+/);
            let valStr = sideParts[0];
            
            if (valStr.startsWith('0b')) {
                sideSetVal = parseInt(valStr.substring(2), 2);
            } else {
                sideSetVal = parseInt(valStr);
            }
            
            // Check for delay in side part
            if (sideParts.length > 1) {
                const delayStr = sideParts[1];
                if (delayStr.startsWith('[') && delayStr.endsWith(']')) {
                    delay = parseInt(delayStr.substring(1, delayStr.length - 1));
                }
            }
        } else {
            // Check for delay at the end of line [N]
            const delayMatch = line.match(/\[(\d+)\]$/);
            if (delayMatch) {
                delay = parseInt(delayMatch[1]);
                mainPart = line.substring(0, line.lastIndexOf('[')).trim();
            }
        }

        // Regex to split instruction parts
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
            default: throw new Error(`Unknown instruction: ${op}`);
        }
        
        instr.sideSet = sideSetVal;
        instr.delay = delay;
        return instr;
    }

    parseJmp(args, pc) {
        // jmp [cond] target
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
        // wait polarity gpio/pin/irq index
        // wait 1 gpio 15
        const polarity = parseInt(args[0]);
        const source = args[1];
        const index = args[2]; // can be number or 'rel' for irq
        
        return { type: 'WAIT', polarity, source, index };
    }

    parseIn(args) {
        // in source, bit_count
        const source = args[0];
        const bitCount = parseInt(args[1]);
        return { type: 'IN', source, bitCount };
    }

    parseOut(args) {
        // out dest, bit_count
        const dest = args[0];
        const bitCount = parseInt(args[1]);
        return { type: 'OUT', dest, bitCount };
    }

    parsePush(args) {
        // push [ifull] [block/noblock]
        const ifull = args.includes('ifull');
        const block = !args.includes('noblock');
        return { type: 'PUSH', ifull, block };
    }

    parsePull(args) {
        // pull [ifempty] [block/noblock]
        const ifempty = args.includes('ifempty');
        const block = !args.includes('noblock');
        return { type: 'PULL', ifempty, block };
    }

    parseMov(args) {
        // mov dest, [op] src
        // args: ["dest", "src"] or ["dest", "op", "src"]
        // But my simple parser splits by space and removes commas.
        // "mov x, ~y" -> ["x", "~y"] (if ~ is attached)
        // "mov x, :: y" -> ["x", "::", "y"]
        
        const dest = args[0];
        let src = '';
        let op = '';
        
        if (args.length === 2) {
            // Check if src has op attached
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
        // irq [clear/wait] index [rel]
        // irq 0
        // irq clear 0
        let clear = false;
        let wait = false;
        let indexStr = '';
        
        // Simple parsing
        for (let arg of args) {
            if (arg === 'clear') clear = true;
            else if (arg === 'wait') wait = true;
            else if (arg !== 'rel') indexStr = arg;
        }
        
        const index = parseInt(indexStr);
        return { type: 'IRQ', clear, wait, index };
    }

    parseSet(args) {
        // set dest, value
        const dest = args[0];
        const value = parseInt(args[1]);
        return { type: 'SET', dest, value };
    }
}
