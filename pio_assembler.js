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
        this.programCount = 0;
        this.stimuli = [];

        const lines = sourceCode.split('\n');
        let pc = 0;

        // First pass: collect labels and directives
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();

            // Simulator-only pragma, written as a comment so that pioasm
            // ignores it:  ; #pragma pio_sim pin 5 hi 3 low 7
            const pragma = line.match(/^;\s*#pragma\s+pio_sim\b([^;]*)/i);
            if (pragma) {
                try {
                    this.handlePragma(pragma[1]);
                } catch (e) {
                    throw new Error(`Line ${i + 1}: ${e.message}`);
                }
                continue;
            }

            const commentIndex = line.indexOf(';');
            if (commentIndex !== -1) {
                line = line.substring(0, commentIndex).trim();
            }
            if (line === '') continue;

            let colonIndex = line.indexOf(':');
            while (colonIndex !== -1 && colonIndex + 1 < line.length && line[colonIndex + 1] === ':') {
                colonIndex = line.indexOf(':', colonIndex + 2);
            }
            if (colonIndex !== -1) {
                const labelName = line.substring(0, colonIndex).trim();
                this.labels[labelName] = pc;
                line = line.substring(colonIndex + 1).trim();
            }

            if (line === '') continue;

            if (line.startsWith('.')) {
                try {
                    this.handleDirective(line, pc);
                } catch (e) {
                    throw new Error(`Line ${i + 1}: ${e.message}`);
                }
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

            let colonIndex = line.indexOf(':');
            while (colonIndex !== -1 && colonIndex + 1 < line.length && line[colonIndex + 1] === ':') {
                colonIndex = line.indexOf(':', colonIndex + 2);
            }
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
            stimuli: this.stimuli,
            programMap: programMap
        };
    }

    // Parse the body of a `; #pragma pio_sim ...` comment.
    //
    //   pin <n> [<level> delay <clocks>] <level> <clocks> ... [count <n>]
    //
    // Drives an input pin with a waveform counted in PIO clocks from reset.
    // `<level>` is hi/high or low/lo. The `<level> <clocks>` segments form one
    // period, repeated forever or `count` times; after that the pin holds the
    // last level. An optional leading `<level> delay <clocks>` holds a level
    // once before the first period.
    handlePragma(body) {
        const tokens = body.trim().split(/\s+/).filter(t => t !== '');
        const usage = `expected '; #pragma pio_sim pin <n> [<hi|low> delay <clocks>] <hi|low> <clocks> ... [count <n>]'`;
        const levels = { hi: 1, high: 1, low: 0, lo: 0 };

        const num = (tok, what) => {
            if (tok !== undefined && Object.prototype.hasOwnProperty.call(this.defines, tok)) {
                return this.defines[tok];
            }
            if (tok === undefined || !/^(0x[0-9a-f]+|\d+)$/i.test(tok)) {
                throw new Error(`#pragma pio_sim: ${what} must be a non-negative integer, got '${tok === undefined ? '' : tok}' (${usage})`);
            }
            return parseInt(tok);
        };

        if (tokens.length === 0 || tokens[0].toLowerCase() !== 'pin') {
            throw new Error(`#pragma pio_sim: unknown pragma '${tokens[0] || ''}' (${usage})`);
        }

        const pin = num(tokens[1], 'pin number');
        if (pin > 31) throw new Error(`#pragma pio_sim: pin ${pin} out of range 0-31`);
        if (this.stimuli.some(s => s.pin === pin)) {
            throw new Error(`#pragma pio_sim: pin ${pin} already has a stimulus`);
        }

        const stim = { pin, delay: 0, delayLevel: 0, segments: [], period: 0, count: null };
        let i = 2;
        while (i < tokens.length) {
            const tok = tokens[i].toLowerCase();

            if (tok === 'count') {
                if (stim.segments.length === 0) {
                    throw new Error(`#pragma pio_sim: 'count' needs a waveform before it (${usage})`);
                }
                stim.count = num(tokens[i + 1], 'count');
                if (stim.count < 1) throw new Error(`#pragma pio_sim: count must be at least 1`);
                if (i + 2 !== tokens.length) {
                    throw new Error(`#pragma pio_sim: 'count <n>' must come last (${usage})`);
                }
                break;
            }

            if (!Object.prototype.hasOwnProperty.call(levels, tok)) {
                throw new Error(`#pragma pio_sim: expected hi or low, got '${tokens[i]}' (${usage})`);
            }
            const level = levels[tok];

            if ((tokens[i + 1] || '').toLowerCase() === 'delay') {
                if (i !== 2) {
                    throw new Error(`#pragma pio_sim: '<level> delay <clocks>' is only allowed right after the pin number`);
                }
                stim.delayLevel = level;
                stim.delay = num(tokens[i + 2], 'delay');
                i += 3;
            } else {
                const clocks = num(tokens[i + 1], `clock count after '${tokens[i]}'`);
                if (clocks < 1) {
                    throw new Error(`#pragma pio_sim: clock count after '${tokens[i]}' must be at least 1`);
                }
                stim.segments.push({ level, clocks });
                stim.period += clocks;
                i += 2;
            }
        }

        if (stim.segments.length === 0) {
            throw new Error(`#pragma pio_sim: pin ${pin} has no waveform (${usage})`);
        }
        this.stimuli.push(stim);
    }

    handleDirective(line, pc) {
        const parts = line.split(/\s+/);
        const directive = parts[0];

        switch (directive) {
            case '.program':
                // One source is one state machine. Without this check a second
                // .program would silently be appended to the first, and the
                // wrap points of the last program would apply to the whole lot.
                this.programCount++;
                if (this.programCount > 1) {
                    throw new Error(`multiple .program blocks are not supported ('${this.programName}', then '${parts[1] || ''}'). This simulator runs a single state machine, so keep one .program per source.`);
                }
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
                // The Delay/side-set field is 5 bits. `count` data bits plus an
                // extra enable bit when `opt` is present must fit within it.
                if (isNaN(this.sidesetCount) || this.sidesetCount < 0 || this.sidesetCount > 5) {
                    throw new Error(`.side_set count must be 0-5`);
                }
                if (this.sidesetCount + (this.sidesetOpt ? 1 : 0) > 5) {
                    throw new Error(`.side_set ${this.sidesetCount} opt needs ${this.sidesetCount + 1} bits, exceeds the 5-bit field`);
                }
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
        
        this.validateSideDelay(sideSetVal, delay);

        instr.sideSet = sideSetVal;
        instr.delay = delay;
        return instr;
    }

    // Check side-set value and delay against the .side_set configuration.
    // The 5-bit Delay/side-set field is split into `sidesetCount` data bits
    // (+1 enable bit when opt), leaving the rest for delay. See RP2350
    // datasheet §11.4.1 / §11.5.1 and the .side_set directive (pioasm_side_set).
    validateSideDelay(sideSetVal, delay) {
        const sideTotalBits = this.sidesetCount + (this.sidesetOpt ? 1 : 0);
        const delayBits = 5 - sideTotalBits;

        if (sideSetVal !== null) {
            if (this.sidesetCount === 0) {
                throw new Error(`'side' used but no side-set bits declared (add .side_set)`);
            }
            const maxSide = (1 << this.sidesetCount) - 1;
            if (sideSetVal < 0 || sideSetVal > maxSide) {
                throw new Error(`side-set value ${sideSetVal} out of range 0-${maxSide} for .side_set ${this.sidesetCount}`);
            }
        } else if (this.sidesetCount > 0 && !this.sidesetOpt) {
            throw new Error(`missing 'side' value (.side_set ${this.sidesetCount} is not optional, so every instruction needs one)`);
        }

        const maxDelay = (1 << delayBits) - 1;
        if (delay < 0 || delay > maxDelay) {
            throw new Error(`delay [${delay}] out of range 0-${maxDelay} (${delayBits} delay bits remain with side-set using ${sideTotalBits})`);
        }
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
        const iffull = args.includes('iffull') || args.includes('ifull');
        const block = !args.includes('noblock');
        return { type: 'PUSH', iffull, block };
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
