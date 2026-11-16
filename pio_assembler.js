// PIO assembler for the simulator.
//
// Follows pioasm from the pico-sdk (tools/pioasm: lexer.ll, parser.yy,
// pio_assembler.cpp): same tokens, grammar, operator precedence and range
// checks, so a source that assembles here means the same thing on hardware.
// Deliberate differences:
//   - one .program per source (the simulator runs a single state machine)
//   - instructions are accepted without a .program line
//   - `; #pragma pio_sim ...` comment lines configure the simulator
//   - `side` without a .side_set declaration is an error

// Reserved words of the pioasm lexer. They cannot be used as symbol names.
const PIO_KEYWORDS = new Set([
    'jmp', 'wait', 'in', 'out', 'push', 'pull', 'mov', 'irq', 'set', 'nop',
    'public', 'opt', 'side', 'pin', 'gpio', 'osre', 'pins', 'null', 'pindirs',
    'x', 'y', 'pc', 'exec', 'isr', 'osr', 'status', 'block', 'noblock',
    'iffull', 'ifempty', 'rel', 'clear', 'nowait', 'jmppin', 'next', 'prev',
    'txrx', 'tx', 'rx', 'txput', 'txget', 'putget', 'rp2040', 'rp2350',
    'rxfifo', 'txfifo', 'left', 'right', 'auto', 'manual'
]);
const PIO_KEYWORD_ALIASES = { optional: 'opt', sideset: 'side', side_set: 'side' };

const PIO_MAX_INSTRUCTIONS = 32;

function pioReverseBits(n) {
    n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
    n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
    n = ((n >>> 4) & 0x0F0F0F0F) | ((n & 0x0F0F0F0F) << 4);
    n = ((n >>> 8) & 0x00FF00FF) | ((n & 0x00FF00FF) << 8);
    return ((n >>> 16) | (n << 16)) >>> 0;
}

// Decode a raw 16-bit instruction (datasheet "Instruction Set" encodings)
// into the object form the emulator executes. Used for .word and for
// OUT EXEC / MOV EXEC. `opts.sidesetCount` is the number of side-set data
// bits, as declared by .side_set.
function pioDecodeInstruction(word, opts) {
    opts = opts || {};
    const sidesetCount = opts.sidesetCount || 0;
    const sidesetOpt = !!opts.sidesetOpt;
    const version = opts.pioVersion === undefined ? 1 : opts.pioVersion;
    word &= 0xFFFF;

    const hex = '0x' + word.toString(16).padStart(4, '0');
    const reserved = what => new Error(`instruction ${hex}: ${what} is a reserved encoding`);
    const needV1 = what => {
        if (version < 1) throw new Error(`instruction ${hex}: ${what} needs PIO version 1 (RP2350)`);
    };

    const field = (word >> 8) & 0x1F;
    const sideBits = sidesetCount + (sidesetOpt ? 1 : 0);
    const delayBits = 5 - sideBits;
    const delay = field & ((1 << delayBits) - 1);
    let sideSet = null;
    if (sideBits > 0) {
        const sideField = field >> delayBits;
        const data = sideField & ((1 << sidesetCount) - 1);
        if (!sidesetOpt || ((sideField >> sidesetCount) & 1)) sideSet = data;
    }

    const arg1 = (word >> 5) & 7;
    const arg2 = word & 0x1F;
    const irqMode = (idx) => {
        if (version < 1) return { rel: (idx & 0x10) !== 0, prev: false, next: false };
        const mode = (idx >> 3) & 3;
        return { rel: mode === 2, prev: mode === 1, next: mode === 3 };
    };

    let instr;
    switch (word >> 13) {
        case 0: {
            const cond = ['', '!x', 'x--', '!y', 'y--', 'x!=y', 'pin', '!osre'][arg1];
            instr = { type: 'JMP', cond, target: arg2 };
            break;
        }
        case 1: {
            const polarity = (arg1 >> 2) & 1;
            const source = ['gpio', 'pin', 'irq', 'jmppin'][arg1 & 3];
            if (source === 'jmppin') needV1('WAIT JMPPIN');
            if (source === 'irq') {
                instr = Object.assign({ type: 'WAIT', polarity, source, index: arg2 & 7 }, irqMode(arg2));
            } else {
                instr = { type: 'WAIT', polarity, source, index: arg2, rel: false, prev: false, next: false };
            }
            break;
        }
        case 2: {
            const source = ['pins', 'x', 'y', 'null', null, 'status', 'isr', 'osr'][arg1];
            if (source === null) throw reserved('IN source 4');
            instr = { type: 'IN', source, bitCount: arg2 || 32 };
            break;
        }
        case 3: {
            const dest = ['pins', 'x', 'y', 'null', 'pindirs', 'pc', 'isr', 'exec'][arg1];
            instr = { type: 'OUT', dest, bitCount: arg2 || 32 };
            break;
        }
        case 4: {
            const isPull = (arg1 >> 2) & 1;
            if (arg2 & 0x10) {
                // RP2350: MOV to/from the RX FIFO storage registers.
                needV1('MOV RXFIFO');
                const index = (arg2 & 8) ? (arg2 & 3) : null; // null: indexed by Y
                instr = isPull
                    ? { type: 'MOV', dest: 'osr', src: 'rxfifo', op: '', index }
                    : { type: 'MOV', dest: 'rxfifo', src: 'isr', op: '', index };
            } else if (isPull) {
                instr = { type: 'PULL', ifempty: !!(arg1 & 2), block: !!(arg1 & 1) };
            } else {
                instr = { type: 'PUSH', iffull: !!(arg1 & 2), block: !!(arg1 & 1) };
            }
            break;
        }
        case 5: {
            const dest = ['pins', 'x', 'y', 'pindirs', 'exec', 'pc', 'isr', 'osr'][arg1];
            if (dest === 'pindirs') needV1('MOV PINDIRS');
            const opCode = (arg2 >> 3) & 3;
            if (opCode === 3) throw reserved('MOV operation 3');
            const src = ['pins', 'x', 'y', 'null', null, 'status', 'isr', 'osr'][arg2 & 7];
            if (src === null) throw reserved('MOV source 4');
            instr = { type: 'MOV', dest, src, op: ['', '~', '::'][opCode] };
            break;
        }
        case 6: {
            if (arg1 & 4) throw reserved('IRQ with bit 7 set');
            instr = Object.assign(
                { type: 'IRQ', clear: !!(arg1 & 2), wait: !!(arg1 & 1), index: arg2 & 7 },
                irqMode(arg2));
            break;
        }
        default: {
            const dest = ['pins', 'x', 'y', null, 'pindirs', null, null, null][arg1];
            if (dest === null) throw reserved(`SET destination ${arg1}`);
            instr = { type: 'SET', dest, value: arg2 };
            break;
        }
    }

    instr.sideSet = sideSet;
    instr.delay = delay;
    return instr;
}

class PioAssembler {
    constructor() {
        this.programName = 'program';
    }

    assemble(sourceCode) {
        // Symbols and pragmas before the first .program are global, as in
        // pioasm. Lines before the first .program also form an unnamed
        // program when they hold instructions (a single-program source
        // without a .program line).
        this.globalSymbols = new Map(); // name -> { isLabel, expr, line, resolving }
        this.globalPragmas = [];
        this.warnings = [];             // [{ line, message }]: assembled anyway
        this.states = [];               // finished programs
        this.inProgram = false;
        this.defaultPioVersion = 1;
        this.startProgram('program', 0, true);

        const rawLines = sourceCode.replace(/\r/g, '').split('\n');
        const scanned = PioAssembler.scanLines(rawLines);

        for (let i = 0; i < scanned.length; i++) {
            this.line = i + 1;
            if (scanned[i].typo) this.warnings.push({ line: this.line, message: scanned[i].typo });
            if (scanned[i].pragma !== null) {
                this.pragmas.push({ body: scanned[i].pragma, line: this.line });
                continue;
            }
            try {
                this.parseLine(PioAssembler.tokenize(scanned[i].code), rawLines[i]);
            } catch (e) {
                throw new Error(`Line ${this.line}: ${e.message}`);
            }
        }
        if (this.inProgram || this.items.length > 0 || this.states.length === 0) {
            this.states.push(this.captureProgram());
        }

        return this.finalize();
    }

    // Per-program assembler state. The fields live on `this` while the
    // program is parsed or finalized.
    startProgram(name, line, implicit) {
        this.programName = name;
        this.programLine = line;
        this.symbols = implicit ? this.globalSymbols : new Map();
        this.pragmas = implicit ? this.globalPragmas : [];
        this.items = [];            // instructions before resolution
        this.sideset = null;        // { expr, opt, pindirs }
        this.wrapTarget = null;
        this.wrap = null;
        this.origin = null;
        this.fifo = 'txrx';
        this.dirIn = null;
        this.dirOut = null;
        this.dirSet = null;
        this.movStatus = null;
        this.clockDiv = null;
        this.pioVersion = this.defaultPioVersion;
    }

    captureProgram() {
        const st = {};
        for (const f of PioAssembler.PROGRAM_FIELDS) st[f] = this[f];
        return st;
    }

    loadProgramState(st) {
        for (const f of PioAssembler.PROGRAM_FIELDS) this[f] = st[f];
    }

    // Strip comments (`;`, `//`, `/* */`) and `% lang { ... %}` pass-through
    // blocks. Returns one { code, pragma } per source line, where `pragma`
    // is the body of a `; #pragma pio_sim ...` comment line, or null.
    static scanLines(rawLines) {
        const out = [];
        let state = 'code';
        for (const raw of rawLines) {
            let code = '';
            let pragma = null;
            let typo = null;

            if (state === 'passthrough') {
                if (raw.trim() === '%}') state = 'code';
                out.push({ code, pragma, typo });
                continue;
            }

            let i = 0;
            while (i < raw.length) {
                if (state === 'block') {
                    const end = raw.indexOf('*/', i);
                    if (end === -1) {
                        i = raw.length;
                    } else {
                        i = end + 2;
                        state = 'code';
                        code += ' ';
                    }
                    continue;
                }

                // .lang_opt takes free-form text up to the end of the line.
                if (/^\s*\.lang_opt\b/i.test(code)) {
                    code += raw.substring(i);
                    break;
                }

                const two = raw.substr(i, 2);
                if (raw[i] === ';' || two === '//') {
                    if (code.trim() === '') {
                        const text = raw.substring(i + (raw[i] === ';' ? 1 : 2));
                        const m = text.match(/^\s*#pragma\s+pio_sim\b(.*)$/i);
                        if (m) {
                            pragma = m[1].split(/;|\/\//)[0];
                        } else {
                            // A pragma that looks like one of ours but does not
                            // say pio_sim would be ignored without a word.
                            const t = text.match(/^\s*#\s*pragma[\s_]+(\S+)/i);
                            if (t && /^(pin|irq|config|sm|pio\S*)$/i.test(t[1])) {
                                typo = `'#pragma ${t[1]}' is not a simulator pragma and is ignored; ` +
                                    `simulator pragmas start with '; #pragma pio_sim'`;
                            }
                        }
                    }
                    break;
                }
                if (two === '/*') {
                    state = 'block';
                    i += 2;
                    continue;
                }
                if (raw[i] === '%' && /^%[ \t]*[^%]+\{/.test(raw.substring(i))) {
                    state = 'passthrough';
                    break;
                }
                code += raw[i];
                i++;
            }
            out.push({ code, pragma, typo });
        }
        return out;
    }

    static tokenize(code) {
        const tokens = [];
        if (/^\s*\.lang_opt\b/i.test(code)) {
            return [{ t: 'dir', s: '.lang_opt' }];
        }
        const re = /\s+|0x[0-9a-fA-F]+|0b[01]+|\d*\.\d+|\d+|[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z_][A-Za-z0-9_]*|::|--|−−|!=|<<|>>|[,:\[\]()+\-*\/|&^!~<]/y;
        let pos = 0;
        while (pos < code.length) {
            re.lastIndex = pos;
            const m = re.exec(code);
            if (!m) throw new Error(`invalid character: ${code[pos]}`);
            pos = re.lastIndex;
            const s = m[0];
            if (/^\s/.test(s)) continue;

            if (/^0x/i.test(s) || /^0b/i.test(s) || /^\d+$/.test(s)) {
                const v = /^0x/i.test(s) ? parseInt(s.substring(2), 16)
                    : /^0b/i.test(s) ? parseInt(s.substring(2), 2)
                        : parseInt(s, 10);
                if (v > 0x7FFFFFFF) throw new Error(`integer is out of range: ${s}`);
                tokens.push({ t: 'int', v, s });
            } else if (/^\d*\.\d+$/.test(s)) {
                tokens.push({ t: 'float', v: parseFloat(s), s });
            } else if (s[0] === '.') {
                tokens.push({ t: 'dir', s: s.toLowerCase() });
            } else if (/^[A-Za-z_]/.test(s)) {
                let k = s.toLowerCase();
                if (k in PIO_KEYWORD_ALIASES) k = PIO_KEYWORD_ALIASES[k];
                if (k === 'one' || k === 'zero') {
                    tokens.push({ t: 'int', v: k === 'one' ? 1 : 0, s });
                } else {
                    tokens.push({ t: 'id', s, k: PIO_KEYWORDS.has(k) ? k : null });
                }
            } else {
                let p = s;
                if (p === '−−') p = '--';
                if (p === '~') p = '!';
                tokens.push({ t: 'p', s: p });
            }
        }
        return tokens;
    }

    // ---- parsing ---------------------------------------------------------

    parseLine(tokens, rawText) {
        if (tokens.length === 0) return;
        this.tok = tokens;
        this.pos = 0;

        if (this.peek().t === 'dir') {
            this.parseDirective(rawText);
            this.expectEnd();
            return;
        }

        const label = this.tryLabel();
        if (label) {
            this.addSymbol(label.name, true, { t: 'int', v: this.items.length });
            if (this.atEnd()) return;
        }

        const item = this.parseInstruction();
        this.expectEnd();
        this.addItem(item, rawText);
    }

    peek(offset = 0) {
        return this.tok[this.pos + offset] || { t: 'end', s: 'end of line' };
    }

    atEnd() {
        return this.pos >= this.tok.length;
    }

    isP(s, offset = 0) {
        const t = this.peek(offset);
        return t.t === 'p' && t.s === s;
    }

    isK(k, offset = 0) {
        const t = this.peek(offset);
        return t.t === 'id' && t.k === k;
    }

    isName(offset = 0) {
        const t = this.peek(offset);
        return t.t === 'id' && t.k === null;
    }

    acceptP(s) {
        if (this.isP(s)) { this.pos++; return true; }
        return false;
    }

    acceptK(k) {
        if (this.isK(k)) { this.pos++; return true; }
        return false;
    }

    // First matching keyword from `list`, consumed; or null.
    acceptAnyK(list) {
        const t = this.peek();
        if (t.t === 'id' && t.k !== null && list.includes(t.k)) {
            this.pos++;
            return t.k;
        }
        return null;
    }

    unexpected(expected) {
        const t = this.peek();
        const got = t.t === 'end' ? 'end of line' : `'${t.s}'`;
        return new Error(`unexpected ${got}${expected ? `, expected ${expected}` : ''}`);
    }

    expectP(s) {
        if (!this.acceptP(s)) throw this.unexpected(`'${s}'`);
    }

    expectEnd() {
        if (!this.atEnd()) throw this.unexpected('end of line');
    }

    // symbol_def: ID | PUBLIC ID | * ID
    parseSymbolDef() {
        if (this.isK('public') || this.isP('*')) this.pos++;
        if (!this.isName()) {
            const t = this.peek();
            if (t.t === 'id') throw new Error(`'${t.s}' is a reserved word and cannot be used as a name`);
            throw this.unexpected('a name');
        }
        return this.tok[this.pos++].s;
    }

    tryLabel() {
        let n = 0;
        if (this.isK('public') || this.isP('*')) n = 1;
        if (this.peek(n).t === 'id' && this.peek(n).k !== null && this.isP(':', n + 1)) {
            throw new Error(`'${this.peek(n).s}' is a reserved word and cannot be used as a label`);
        }
        if (this.isName(n) && this.isP(':', n + 1)) {
            const name = this.peek(n).s;
            this.pos += n + 2;
            return { name };
        }
        return null;
    }

    // value: INT | ID | ( expression )
    parseValue() {
        const t = this.peek();
        if (t.t === 'int') {
            this.pos++;
            return { t: 'int', v: t.v };
        }
        if (t.t === 'id' && t.k === null) {
            this.pos++;
            return { t: 'name', name: t.s };
        }
        if (this.acceptP('(')) {
            const e = this.parseExpr(1);
            this.expectP(')');
            return e;
        }
        throw this.unexpected('a value');
    }

    // Binary operator precedence, lowest first, as declared in parser.yy:
    //   <<  >>   then   +  -   then   *  /   then   &  |  ^
    // Unary minus binds like binary minus; unary :: binds loosest of all.
    static binaryPrecedence(tok) {
        if (tok.t !== 'p') return 0;
        switch (tok.s) {
            case '<<': case '>>': return 1;
            case '+': case '-': return 2;
            case '*': case '/': return 3;
            case '&': case '|': case '^': return 4;
            default: return 0;
        }
    }

    parseExpr(minPrec) {
        let left;
        if (this.acceptP('-')) {
            left = { t: 'un', op: '-', a: this.parseExpr(3) };
        } else if (this.acceptP('::')) {
            left = { t: 'un', op: '::', a: this.parseExpr(1) };
        } else {
            left = this.parseValue();
        }
        for (;;) {
            const p = PioAssembler.binaryPrecedence(this.peek());
            if (p === 0 || p < minPrec) return left;
            const op = this.tok[this.pos++].s;
            left = { t: 'bin', op, l: left, r: this.parseExpr(p + 1) };
        }
    }

    requireVersion(version, what) {
        if (this.pioVersion < version) {
            throw new Error(`${what} requires PIO version ${version} (RP2350); this program targets version ${this.pioVersion}`);
        }
    }

    beforeInstructions(directive) {
        if (this.items.length > 0) {
            throw new Error(`${directive} must precede any program instructions`);
        }
    }

    parseDirective(rawText) {
        const dir = this.tok[this.pos++].s;
        switch (dir) {
            case '.program': {
                if (!this.isName()) throw this.unexpected('a program name');
                const name = this.tok[this.pos++].s;
                if (this.inProgram) {
                    this.states.push(this.captureProgram());
                } else {
                    if (this.items.length > 0) {
                        throw new Error('.program must precede any program instructions');
                    }
                    this.defaultPioVersion = this.pioVersion;
                }
                if (this.states.some(st => st.programName === name)) {
                    throw new Error(`program ${name} already exists`);
                }
                this.startProgram(name, this.line, false);
                this.inProgram = true;
                break;
            }
            case '.define': {
                const name = this.parseSymbolDef();
                this.addSymbol(name, false, this.parseExpr(1));
                break;
            }
            case '.origin':
                this.beforeInstructions('.origin');
                this.origin = { expr: this.parseValue(), line: this.line };
                break;
            case '.pio_version': {
                this.beforeInstructions('.pio_version');
                let v;
                if (this.acceptK('rp2040')) v = 0;
                else if (this.acceptK('rp2350')) v = 1;
                else if (this.peek().t === 'int') v = this.tok[this.pos++].v;
                else throw this.unexpected('0, 1, rp2040 or rp2350');
                if (v < 0 || v > 1) throw new Error('only PIO versions 0 (rp2040) and 1 (rp2350) are supported');
                this.pioVersion = v;
                break;
            }
            case '.side_set': {
                this.beforeInstructions('.side_set');
                const expr = this.parseValue();
                const opt = this.acceptK('opt');
                const pindirs = this.acceptK('pindirs');
                this.sideset = { expr, opt, pindirs, line: this.line };
                break;
            }
            case '.in':
            case '.out': {
                this.beforeInstructions(dir);
                const count = this.parseValue();
                let right = true;
                if (this.acceptK('left')) right = false;
                else this.acceptK('right');
                let auto = false;
                if (this.acceptK('auto')) auto = true;
                else this.acceptK('manual');
                const threshold = this.atEnd() ? { t: 'int', v: 32 } : this.parseValue();
                const cfg = { count, right, auto, threshold, line: this.line };
                if (dir === '.in') this.dirIn = cfg;
                else this.dirOut = cfg;
                break;
            }
            case '.set':
                this.beforeInstructions('.set');
                this.dirSet = { expr: this.parseValue(), line: this.line };
                break;
            case '.wrap_target':
                if (this.wrapTarget !== null) throw new Error('.wrap_target was already specified');
                this.wrapTarget = this.items.length;
                break;
            case '.wrap':
                if (this.wrap !== null) throw new Error('.wrap was already specified');
                if (this.items.length === 0) {
                    throw new Error('.wrap cannot be placed before the first program instruction');
                }
                this.wrap = this.items.length - 1;
                break;
            case '.word':
                this.addItem({ kind: 'word', expr: this.parseValue(), side: null, delay: null }, rawText);
                break;
            case '.lang_opt':
                // Options for pioasm's output generators; nothing to simulate.
                break;
            case '.clock_div': {
                // Applied as the state machine's clock divider. It changes
                // input latency, counted in state machine cycles.
                const t = this.peek();
                if (t.t !== 'int' && t.t !== 'float') throw this.unexpected('a clock divider');
                this.pos++;
                if (t.v < 1 || t.v >= 65536) throw new Error('clock divider must be between 1 and 65535');
                this.clockDiv = t.v;
                break;
            }
            case '.fifo': {
                this.beforeInstructions('.fifo');
                const cfg = this.acceptAnyK(['txrx', 'tx', 'rx', 'txput', 'txget', 'putget']);
                if (cfg === null) throw this.unexpected('txrx, tx, rx, txput, txget or putget');
                if (cfg === 'txput' || cfg === 'txget' || cfg === 'putget') {
                    this.requireVersion(1, `.fifo ${cfg}`);
                }
                this.fifo = cfg;
                break;
            }
            case '.mov_status': {
                this.beforeInstructions('.mov_status');
                if (this.acceptK('txfifo')) {
                    this.expectP('<');
                    this.movStatus = { type: 'tx', n: this.parseValue() };
                } else if (this.acceptK('rxfifo')) {
                    this.expectP('<');
                    this.movStatus = { type: 'rx', n: this.parseValue() };
                } else if (this.acceptK('irq')) {
                    let param = 0;
                    if (this.acceptK('prev')) param = 1;
                    else if (this.acceptK('next')) param = 2;
                    if (!this.acceptK('set')) throw this.unexpected("'set'");
                    this.requireVersion(1, '.mov_status irq');
                    this.movStatus = { type: 'irq', n: this.parseValue(), param };
                } else {
                    throw new Error("expected 'txfifo < N', 'rxfifo < N' or 'irq set N'");
                }
                this.movStatus.line = this.line;
                break;
            }
            default:
                throw new Error(`unknown directive ${dir}`);
        }
    }

    // instruction: base (side <value>) ([<delay>]), side and delay in either order
    parseInstruction() {
        const item = this.parseBase();
        item.side = null;
        item.delay = null;
        for (let n = 0; n < 2; n++) {
            if (item.side === null && this.acceptK('side')) {
                item.side = this.parseValue();
            } else if (item.delay === null && this.acceptP('[')) {
                item.delay = this.parseExpr(1);
                this.expectP(']');
            } else {
                break;
            }
        }
        return item;
    }

    parseBase() {
        const t = this.peek();
        const op = t.t === 'id' ? t.k : null;
        const instructions = ['nop', 'jmp', 'wait', 'in', 'out', 'push', 'pull', 'mov', 'irq', 'set'];
        if (!instructions.includes(op)) {
            if (t.t === 'id' && t.k === null) throw new Error(`Unknown instruction: ${t.s}`);
            throw this.unexpected('an instruction');
        }
        this.pos++;

        const operand = (list, what) => {
            const k = this.acceptAnyK(list);
            if (k === null) throw this.unexpected(`${what} (${list.join(', ')})`);
            return k;
        };

        switch (op) {
            case 'nop':
                return { kind: 'instr', type: 'MOV', dest: 'y', src: 'y', op: '' };

            case 'jmp': {
                let cond = '';
                if (this.isP('!') && this.isK('x', 1)) { cond = '!x'; this.pos += 2; }
                else if (this.isP('!') && this.isK('y', 1)) { cond = '!y'; this.pos += 2; }
                else if (this.isP('!') && this.isK('osre', 1)) { cond = '!osre'; this.pos += 2; }
                else if (this.isK('x') && this.isP('--', 1)) { cond = 'x--'; this.pos += 2; }
                else if (this.isK('y') && this.isP('--', 1)) { cond = 'y--'; this.pos += 2; }
                else if (this.isK('x') && this.isP('!=', 1) && this.isK('y', 2)) { cond = 'x!=y'; this.pos += 3; }
                else if (this.isK('pin')) { cond = 'pin'; this.pos += 1; }
                this.acceptP(',');
                return { kind: 'instr', type: 'JMP', cond, target: this.parseExpr(1) };
            }

            case 'wait': {
                const sources = ['irq', 'gpio', 'pin', 'jmppin'];
                const startsWithSource = this.peek().t === 'id' && sources.includes(this.peek().k);
                const polarity = startsWithSource ? { t: 'int', v: 1 } : this.parseValue();
                const source = this.acceptAnyK(sources);
                if (source === null) throw this.unexpected('irq, gpio, pin or jmppin');
                const item = { kind: 'instr', type: 'WAIT', polarity, source, rel: false, prev: false, next: false };
                if (source === 'irq') {
                    if (this.acceptK('prev')) item.prev = true;
                    else if (this.acceptK('next')) item.next = true;
                    if (item.prev || item.next) this.requireVersion(1, `wait irq ${item.prev ? 'prev' : 'next'}`);
                    this.acceptP(',');
                    item.index = this.parseValue();
                    if (this.acceptK('rel')) {
                        if (item.prev || item.next) {
                            throw new Error(`'rel' is not supported for 'irq ${item.prev ? 'prev' : 'next'}'`);
                        }
                        item.rel = true;
                    }
                } else if (source === 'jmppin') {
                    this.requireVersion(1, 'wait jmppin');
                    item.index = this.acceptP('+') ? this.parseValue() : { t: 'int', v: 0 };
                } else {
                    this.acceptP(',');
                    item.index = this.parseValue();
                }
                return item;
            }

            case 'in': {
                const source = operand(['pins', 'x', 'y', 'null', 'isr', 'osr', 'status'], 'an IN source');
                this.acceptP(',');
                return { kind: 'instr', type: 'IN', source, bitCount: this.parseValue() };
            }

            case 'out': {
                const dest = operand(['pins', 'x', 'y', 'null', 'pindirs', 'isr', 'pc', 'exec'], 'an OUT destination');
                this.acceptP(',');
                return { kind: 'instr', type: 'OUT', dest, bitCount: this.parseValue() };
            }

            case 'push': {
                const iffull = this.acceptK('iffull');
                const block = this.acceptK('noblock') ? false : (this.acceptK('block'), true);
                if (this.fifo !== 'txrx' && this.fifo !== 'rx') {
                    throw new Error("FIFO must be configured for 'txrx' or 'rx' to use this instruction");
                }
                return { kind: 'instr', type: 'PUSH', iffull, block };
            }

            case 'pull': {
                const ifempty = this.acceptK('ifempty');
                const block = this.acceptK('noblock') ? false : (this.acceptK('block'), true);
                return { kind: 'instr', type: 'PULL', ifempty, block };
            }

            case 'mov': {
                const item = { kind: 'instr', type: 'MOV', op: '', index: null };
                const fifoIndex = () => {
                    this.requireVersion(1, 'mov rxfifo[]');
                    this.expectP('[');
                    const idx = this.acceptK('y') ? null : this.parseValue();
                    this.expectP(']');
                    return idx;
                };
                if (this.acceptK('rxfifo')) {
                    item.dest = 'rxfifo';
                    item.index = fifoIndex();
                } else {
                    item.dest = operand(['pins', 'x', 'y', 'exec', 'pc', 'isr', 'osr', 'pindirs'], 'a MOV destination');
                    if (item.dest === 'pindirs') this.requireVersion(1, 'mov pindirs');
                }
                this.acceptP(',');
                if (this.acceptP('!')) item.op = '~';
                else if (this.acceptP('::')) item.op = '::';
                if (this.acceptK('rxfifo')) {
                    item.src = 'rxfifo';
                    item.index = fifoIndex();
                } else {
                    item.src = operand(['pins', 'x', 'y', 'null', 'status', 'isr', 'osr'], 'a MOV source');
                }

                if (item.dest === 'rxfifo') {
                    if (item.src !== 'isr') throw new Error('mov rxfifo[] source must be isr');
                    if (this.fifo !== 'txput' && this.fifo !== 'putget') {
                        throw new Error("FIFO must be configured for 'txput' or 'putget' to use this instruction");
                    }
                } else if (item.src === 'rxfifo') {
                    if (item.dest !== 'osr') throw new Error('mov ..., rxfifo[] target must be osr');
                    if (this.fifo !== 'txget' && this.fifo !== 'putget') {
                        throw new Error("FIFO must be configured for 'txget' or 'putget' to use this instruction");
                    }
                }
                return item;
            }

            case 'irq': {
                const item = { kind: 'instr', type: 'IRQ', clear: false, wait: false, rel: false, prev: false, next: false };
                if (this.acceptK('prev')) item.prev = true;
                else if (this.acceptK('next')) item.next = true;
                if (item.prev || item.next) this.requireVersion(1, `irq ${item.prev ? 'prev' : 'next'}`);
                if (this.acceptK('clear')) item.clear = true;
                else if (this.acceptK('wait')) item.wait = true;
                else if (!this.acceptK('nowait')) this.acceptK('set');
                item.index = this.parseValue();
                if (this.acceptK('rel')) {
                    if (item.prev || item.next) {
                        throw new Error(`'rel' is not supported for 'irq ${item.prev ? 'prev' : 'next'}'`);
                    }
                    item.rel = true;
                }
                return item;
            }

            default: { // set
                const dest = operand(['pins', 'x', 'y', 'pindirs'], 'a SET destination');
                this.acceptP(',');
                return { kind: 'instr', type: 'SET', dest, value: this.parseValue() };
            }
        }
    }

    // A program's own symbol, or else a global one.
    lookupSymbol(name) {
        return this.symbols.get(name) || this.globalSymbols.get(name);
    }

    addSymbol(name, isLabel, expr) {
        const existing = this.lookupSymbol(name);
        if (existing) {
            if (existing.isLabel !== isLabel) {
                throw new Error(`'${name}' was already defined as a ${existing.isLabel ? 'label' : 'value'} at line ${existing.line}`);
            }
            throw new Error(`${isLabel ? 'label ' : ''}'${name}' was already defined at line ${existing.line}`);
        }
        this.symbols.set(name, { isLabel, expr, line: this.line, resolving: false });
    }

    addItem(item, rawText) {
        if (this.items.length >= PIO_MAX_INSTRUCTIONS) {
            throw new Error(`program instruction limit of ${PIO_MAX_INSTRUCTIONS} instruction(s) exceeded`);
        }
        item.line = this.line;
        item.text = rawText;
        this.items.push(item);
    }

    // ---- resolution ------------------------------------------------------

    // Evaluate an expression with C `int` semantics, as pioasm does.
    resolve(expr) {
        switch (expr.t) {
            case 'int':
                return expr.v | 0;
            case 'name': {
                const sym = this.lookupSymbol(expr.name);
                if (!sym) throw new Error(`undefined symbol '${expr.name}'`);
                if (sym.resolving) throw new Error(`circular dependency in definition of '${expr.name}'`);
                sym.resolving = true;
                try {
                    return this.resolve(sym.expr);
                } finally {
                    sym.resolving = false;
                }
            }
            case 'un': {
                const v = this.resolve(expr.a);
                return expr.op === '-' ? (-v) | 0 : pioReverseBits(v) | 0;
            }
            default: {
                const l = this.resolve(expr.l);
                const r = this.resolve(expr.r);
                switch (expr.op) {
                    case '+': return (l + r) | 0;
                    case '-': return (l - r) | 0;
                    case '*': return Math.imul(l, r);
                    case '/':
                        if (r === 0) throw new Error('division by zero');
                        return (l / r) | 0;
                    case '&': return l & r;
                    case '|': return l | r;
                    case '^': return l ^ r;
                    case '<<': return l << r;
                    default: return l >> r;
                }
            }
        }
    }

    // Resolve every program, apply the pragmas, lay the programs out in the
    // 32-word instruction memory and decide which state machine runs which.
    finalize() {
        const atLine = (line, fn) => {
            try {
                return fn();
            } catch (e) {
                throw new Error(`Line ${line}: ${e.message}`);
            }
        };

        const programs = this.states.map(st => {
            this.loadProgramState(st);
            return this.finalizeProgram();
        });

        // Pragmas. Pin waveforms and IRQ events belong to the whole block.
        // A `config` pragma before the first .program applies to every state
        // machine; one inside a program, to the state machines running it.
        const stimuli = [];
        const irqEvents = [];
        const smAssign = [];
        const smConfig = [];          // per state machine, from `config sm <n>`
        const globalConfig = {};
        const runPragmas = (list, config) => {
            const out = { stimuli, irqEvents, config, configSeen: new Set(), smAssign, smConfig };
            for (const p of list) atLine(p.line, () => { this.line = p.line; this.handlePragma(p.body, out); });
        };
        this.symbols = this.globalSymbols;
        runPragmas(this.globalPragmas, globalConfig);
        const programConfigs = this.states.map((st, i) => {
            if (st.pragmas === this.globalPragmas) return {};
            this.loadProgramState(st);
            const c = {};
            runPragmas(st.pragmas, c);
            return c;
        });

        // Layout: programs with .origin go there; the others take the first
        // free addresses in source order.
        const used = new Array(32).fill(null);
        const place = (p, at) => {
            for (let a = at; a < at + p.instructions.length; a++) used[a] = p.name;
            p.offset = at;
        };
        for (const p of programs.filter(p => p.origin !== null)) {
            atLine(p.line, () => {
                if (p.origin + p.instructions.length > 32) {
                    throw new Error(`program ${p.name} does not fit at .origin ${p.origin}`);
                }
                for (let a = p.origin; a < p.origin + p.instructions.length; a++) {
                    if (used[a] !== null) throw new Error(`program ${p.name} at .origin ${p.origin} overlaps program ${used[a]}`);
                }
                place(p, p.origin);
            });
        }
        for (const p of programs.filter(p => p.origin === null)) {
            let at = -1;
            for (let a = 0; a + p.instructions.length <= 32 && at < 0; a++) {
                if (used.slice(a, a + p.instructions.length).every(u => u === null)) at = a;
            }
            if (at < 0) {
                const total = programs.reduce((n, q) => n + q.instructions.length, 0);
                throw new Error(`Line ${p.line}: no room for program ${p.name} (${p.instructions.length} instructions): ` +
                    `the programs need ${total} of the 32 instruction memory words`);
            }
            place(p, at);
        }

        const memory = [];
        for (const p of programs) {
            p.instructions.forEach((instr, i) => {
                memory[p.offset + i] = instr.type === 'JMP' ? Object.assign({}, instr, { target: instr.target + p.offset }) : instr;
            });
            p.programMap = p.programMap.map(m => Object.assign({}, m, { pc: m.pc + p.offset }));
        }

        // Which program each state machine runs: `; #pragma pio_sim sm`, or
        // else the programs in source order on SM0, SM1, ...
        let smPrograms;
        if (smAssign.length > 0) {
            smPrograms = [null, null, null, null];
            for (const a of smAssign) {
                atLine(a.line, () => {
                    if (a.program === null) return;
                    const idx = programs.findIndex(p => p.name === a.program);
                    if (idx < 0) throw new Error(`#pragma pio_sim: no program named '${a.program}'`);
                    smPrograms[a.sm] = idx;
                });
            }
        } else {
            if (programs.length > 4) {
                throw new Error(`Line ${programs[4].line}: ${programs.length} programs but 4 state machines; ` +
                    `say which program runs where with '; #pragma pio_sim sm <n> program <name>'`);
            }
            smPrograms = [0, 1, 2, 3].map(i => i < programs.length ? i : null);
        }

        // Settings per state machine: the program's directives, then global
        // config pragmas, then the program's own config pragmas, then
        // `config sm <n>` for that state machine.
        const smConfigs = smPrograms.map((idx, sm) => idx === null ? null
            : Object.assign({}, programs[idx].config, globalConfig, programConfigs[idx], smConfig[sm] ? smConfig[sm].config : {}));

        const result = programs.map(p => ({
            name: p.name, line: p.line, offset: p.offset, length: p.instructions.length,
            pioVersion: p.pioVersion,
            instructions: p.instructions,
            wrapTarget: p.wrapTarget + p.offset, wrap: p.wrap + p.offset,
            sidesetCount: p.sidesetCount, sidesetOpt: p.sidesetOpt, sidesetPindirs: p.sidesetPindirs,
            labels: p.labels, defines: p.defines,
            config: Object.assign({}, p.config, globalConfig, programConfigs[programs.indexOf(p)]),
            programMap: p.programMap
        }));

        // The first program also at the top level, program-relative, for
        // single-program use.
        const first = programs[0];
        return {
            programName: first.name,
            pioVersion: first.pioVersion,
            instructions: first.instructions,
            labels: first.labels,
            defines: first.defines,
            origin: first.origin,
            wrapTarget: first.wrapTarget,
            wrap: first.wrap,
            sidesetCount: first.sidesetCount,
            sidesetOpt: first.sidesetOpt,
            sidesetPindirs: first.sidesetPindirs,
            config: smConfigs[0] || result[0].config,
            stimuli,
            irqEvents,
            warnings: this.warnings,
            programMap: result[0].programMap,
            programs: result,
            memory,
            smPrograms,
            smConfigs
        };
    }

    finalizeProgram() {
        const atLine = (line, fn) => {
            try {
                return fn();
            } catch (e) {
                throw new Error(`Line ${line}: ${e.message}`);
            }
        };
        const range = (v, lo, hi, what) => {
            if (v < lo || v > hi) throw new Error(`${what} must be >= ${lo} and <= ${hi} (got ${v})`);
            return v;
        };

        // Side-set layout: `count` data bits, plus an enable bit when opt.
        let sidesetCount = 0;
        let sidesetOpt = false;
        let sidesetPindirs = false;
        if (this.sideset) atLine(this.sideset.line, () => {
            sidesetCount = this.resolve(this.sideset.expr);
            sidesetOpt = this.sideset.opt;
            sidesetPindirs = this.sideset.pindirs;
            if (sidesetCount < 0) throw new Error('number of side set bits must be positive');
            if (sidesetCount + (sidesetOpt ? 1 : 0) > 5) {
                throw new Error(sidesetOpt
                    ? 'maximum number of side set bits with optional is 4'
                    : 'maximum number of side set bits is 5');
            }
        });
        const sideBits = sidesetCount + (sidesetOpt ? 1 : 0);
        const delayMax = (1 << (5 - sideBits)) - 1;
        const sidesetMax = (1 << sidesetCount) - 1;
        const decodeOpts = { sidesetCount, sidesetOpt, pioVersion: this.pioVersion };

        const instructions = [];
        const programMap = [];
        this.items.forEach((item, pc) => atLine(item.line, () => {
            let instr;
            if (item.kind === 'word') {
                const value = this.resolve(item.expr);
                if (value < 0 || value > 0xFFFF) throw new Error('.word value must be a positive 16 bit value');
                instr = pioDecodeInstruction(value, decodeOpts);
            } else {
                instr = this.buildInstruction(item, range);

                let delay = 0;
                if (item.delay !== null) {
                    delay = this.resolve(item.delay);
                    if (delay < 0) throw new Error('instruction delay must be positive');
                    if (delay > delayMax) {
                        throw new Error(delayMax === 31
                            ? 'instruction delay must be <= 31'
                            : `the instruction delay limit is ${delayMax} because of the .side_set declaration`);
                    }
                }

                let sideSet = null;
                if (item.side !== null) {
                    if (!this.sideset) {
                        throw new Error("'side' used but no side-set bits declared (add .side_set)");
                    }
                    sideSet = this.resolve(item.side);
                    if (sideSet < 0) throw new Error('side set value must be >= 0');
                    if (sideSet > sidesetMax) {
                        throw new Error(`the maximum side set value is ${sidesetMax} for .side_set ${sidesetCount}`);
                    }
                } else if (this.sideset && !sidesetOpt) {
                    throw new Error("instruction requires 'side' to specify side set value for the instruction because non optional sideset was specified for the program");
                }

                instr.sideSet = sideSet;
                instr.delay = delay;
            }
            instructions.push(instr);
            programMap.push({ pc, line: item.line, text: item.text });
        }));

        // Symbols, for reference by the caller.
        const labels = {};
        const defines = {};
        const visible = this.symbols === this.globalSymbols
            ? [...this.symbols] : [...this.globalSymbols, ...this.symbols];
        for (const [name, sym] of visible) {
            const value = atLine(sym.line, () => this.resolve(sym.expr));
            if (sym.isLabel) labels[name] = value;
            else defines[name] = value;
        }

        // State machine configuration requested by directives. Only the
        // settings a directive actually names are reported.
        const config = {};
        if (this.dirOut) atLine(this.dirOut.line, () => {
            const count = range(this.resolve(this.dirOut.count), 0, 32, 'out pin count');
            const threshold = range(this.resolve(this.dirOut.threshold), 1, 32, 'threshold');
            config.outCount = count;
            config.outShiftDir = this.dirOut.right ? 'right' : 'left';
            config.autoPull = this.dirOut.auto;
            config.pullThresh = threshold;
        });
        if (this.dirIn) atLine(this.dirIn.line, () => {
            const count = this.resolve(this.dirIn.count);
            if (this.pioVersion === 0 && count !== 32) throw new Error('in pin count must be 32 for PIO version 0');
            range(count, 1, 32, 'in pin count');
            const threshold = range(this.resolve(this.dirIn.threshold), 1, 32, 'threshold');
            if (this.dirIn.auto && ['txput', 'txget', 'putget'].includes(this.fifo)) {
                throw new Error(`autopush is incompatible with the '.fifo ${this.fifo}' configuration`);
            }
            config.inCount = count;
            config.inShiftDir = this.dirIn.right ? 'right' : 'left';
            config.autoPush = this.dirIn.auto;
            config.pushThresh = threshold;
        });
        if (this.dirSet) atLine(this.dirSet.line, () => {
            config.setCount = range(this.resolve(this.dirSet.expr), 0, 5, 'set pin count');
        });
        if (this.fifo !== 'txrx') {
            config.fifoMode = this.fifo;
        }
        if (this.clockDiv !== null) {
            // CLKDIV holds 16 integer and 8 fractional bits.
            config.clkDiv = Math.floor(this.clockDiv * 256) / 256;
        }
        if (this.movStatus) atLine(this.movStatus.line, () => {
            const n = this.resolve(this.movStatus.n);
            if (this.movStatus.type === 'irq') {
                if (n < 0 || n > 7) throw new Error('irq number should be >= 0 and <= 7');
                config.statusSel = 2;
                config.statusN = this.movStatus.param * 8 + n;
            } else {
                if (n < 0 || n > 31) throw new Error('fifo depth should be >= 0 and <= 31');
                config.statusSel = this.movStatus.type === 'rx' ? 1 : 0;
                config.statusN = n;
            }
        });
        const origin = this.origin === null
            ? null
            : atLine(this.origin.line, () => range(this.resolve(this.origin.expr), 0, 31, 'origin'));

        return {
            name: this.programName,
            line: this.programLine,
            pioVersion: this.pioVersion,
            instructions,
            labels,
            defines,
            origin,
            wrapTarget: this.wrapTarget === null ? 0 : this.wrapTarget,
            wrap: this.wrap === null ? instructions.length - 1 : this.wrap,
            sidesetCount,
            sidesetOpt,
            sidesetPindirs,
            config,
            programMap
        };
    }

    buildInstruction(item, range) {
        switch (item.type) {
            case 'JMP': {
                const target = this.resolve(item.target);
                if (target < 0) throw new Error('jmp target address must be positive');
                if (target >= this.items.length) {
                    throw new Error(`jmp target address ${target} is beyond the end of the program`);
                }
                return { type: 'JMP', cond: item.cond, target };
            }
            case 'WAIT': {
                const polarity = this.resolve(item.polarity);
                if (polarity !== 0 && polarity !== 1) throw new Error("'wait' polarity must be 0 or 1");
                const index = this.resolve(item.index);
                switch (item.source) {
                    case 'irq': range(index, 0, 7, 'irq number'); break;
                    case 'gpio':
                        if (index >= 32 && index <= 47 && this.pioVersion >= 1) {
                            throw new Error('GPIO numbers above 31 are not supported by this simulator');
                        }
                        range(index, 0, 31, 'absolute GPIO number');
                        break;
                    case 'pin': range(index, 0, 31, 'pin number'); break;
                    default: range(index, 0, 3, 'jmppin offset'); break;
                }
                return { type: 'WAIT', polarity, source: item.source, index, rel: item.rel, prev: item.prev, next: item.next };
            }
            case 'IN':
                return { type: 'IN', source: item.source, bitCount: range(this.resolve(item.bitCount), 1, 32, "'in' bit count") };
            case 'OUT':
                return { type: 'OUT', dest: item.dest, bitCount: range(this.resolve(item.bitCount), 1, 32, "'out' bit count") };
            case 'PUSH':
                return { type: 'PUSH', iffull: item.iffull, block: item.block };
            case 'PULL':
                return { type: 'PULL', ifempty: item.ifempty, block: item.block };
            case 'MOV': {
                const instr = { type: 'MOV', dest: item.dest, src: item.src, op: item.op };
                if (item.dest === 'rxfifo' || item.src === 'rxfifo') {
                    // Indexed by Y (null) or by an immediate; hardware uses the two LSBs.
                    instr.index = item.index === null ? null : range(this.resolve(item.index), 0, 7, 'FIFO index') & 3;
                }
                return instr;
            }
            case 'IRQ':
                return {
                    type: 'IRQ', clear: item.clear, wait: item.wait, rel: item.rel,
                    prev: item.prev, next: item.next,
                    index: range(this.resolve(item.index), 0, 7, 'irq number')
                };
            default:
                return { type: 'SET', dest: item.dest, value: range(this.resolve(item.value), 0, 31, "'set' value") };
        }
    }

    // ---- simulator pragmas ----------------------------------------------
    //
    // `; #pragma pio_sim ...` comment lines carry simulator setup in the
    // source. pioasm sees ordinary comments. Three forms:
    //
    //   pin <n> [<level> delay <clocks>] <level> <clocks> ... [count <n>]
    //   irq set|clear <n> [delay <clocks>] [repeat <clocks>] [count <n>]
    //   config <name> <value> [<name> <value> ...]
    //
    // Numbers may be decimal, 0x hex, 0b binary, or a .define name.
    handlePragma(body, out) {
        const tokens = body.trim().split(/\s+/).filter(t => t !== '');
        const kind = (tokens[0] || '').toLowerCase();
        switch (kind) {
            case 'pin': this.pragmaPin(tokens, out.stimuli); break;
            case 'irq': this.pragmaIrq(tokens, out.irqEvents); break;
            case 'config': this.pragmaConfig(tokens, out.config, out.configSeen, out); break;
            case 'sm': this.pragmaSm(tokens, out.smAssign); break;
            default:
                throw new Error(`#pragma pio_sim: unknown pragma '${tokens[0] || ''}' (expected pin, irq, config or sm)`);
        }
    }

    // sm: which program a state machine runs.
    //   sm <n> program <name>     sm <n> off
    // With any `sm` pragma, state machines not named stay off.
    pragmaSm(tokens, smAssign) {
        const usage = `expected '; #pragma pio_sim sm <0-3> program <name>' or '; #pragma pio_sim sm <0-3> off'`;
        if (!/^[0-3]$/.test(tokens[1] || '')) {
            throw new Error(`#pragma pio_sim: state machine number must be 0-3, got '${tokens[1] || ''}' (${usage})`);
        }
        const sm = parseInt(tokens[1]);
        const what = (tokens[2] || '').toLowerCase();
        let program;
        if (what === 'program' && tokens.length === 4) program = tokens[3];
        else if (what === 'off' && tokens.length === 3) program = null;
        else throw new Error(`#pragma pio_sim: ${usage}`);
        if (smAssign.some(a => a.sm === sm)) throw new Error(`#pragma pio_sim: sm ${sm} given twice`);
        smAssign.push({ sm, program, line: this.line });
    }

    pragmaNumber(tok, what, usage) {
        if (tok !== undefined && this.lookupSymbol(tok)) {
            return this.resolve({ t: 'name', name: tok });
        }
        if (tok === undefined || !/^(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(tok)) {
            throw new Error(`#pragma pio_sim: ${what} must be a non-negative integer, got '${tok === undefined ? '' : tok}' (${usage})`);
        }
        return /^0b/i.test(tok) ? parseInt(tok.substring(2), 2) : parseInt(tok);
    }

    // pin: drive an input pin with a waveform counted in PIO clocks from
    // reset. `<level>` is hi/high or low/lo. The `<level> <clocks>` segments
    // form one period, repeated forever or `count` times; after that the pin
    // holds the last level. An optional leading `<level> delay <clocks>`
    // holds a level once before the first period.
    pragmaPin(tokens, stimuli) {
        const usage = `expected '; #pragma pio_sim pin <n> [<hi|low> delay <clocks>] <hi|low> <clocks> ... [count <n>]'`;
        const levels = { hi: 1, high: 1, low: 0, lo: 0 };
        const num = (tok, what) => this.pragmaNumber(tok, what, usage);

        const pin = num(tokens[1], 'pin number');
        if (pin < 0 || pin > 31) throw new Error(`#pragma pio_sim: pin ${pin} out of range 0-31`);
        if (stimuli.some(s => s.pin === pin)) {
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
                if (stim.delay < 0) throw new Error(`#pragma pio_sim: delay must not be negative`);
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
        stimuli.push(stim);
    }

    // irq: raise or clear an IRQ flag at given clocks, standing in for the
    // `irq set` / `irq clear` of another state machine. The first event is at
    // clock `delay` (default 0); with `repeat` it recurs every that many
    // clocks, forever or `count` times. The instruction executed on that
    // clock already sees the new flag value.
    pragmaIrq(tokens, irqEvents) {
        const usage = `expected '; #pragma pio_sim irq set|clear <n> [delay <clocks>] [repeat <clocks>] [count <n>]'`;
        const num = (tok, what) => this.pragmaNumber(tok, what, usage);

        const action = (tokens[1] || '').toLowerCase();
        if (action !== 'set' && action !== 'clear') {
            throw new Error(`#pragma pio_sim: expected 'irq set' or 'irq clear', got 'irq ${tokens[1] || ''}' (${usage})`);
        }
        const flag = num(tokens[2], 'irq number');
        if (flag < 0 || flag > 7) throw new Error(`#pragma pio_sim: irq ${flag} out of range 0-7`);

        const ev = { flag, action, delay: 0, repeat: null, count: null };
        const seen = new Set();
        for (let i = 3; i < tokens.length; i += 2) {
            const key = tokens[i].toLowerCase();
            if (key !== 'delay' && key !== 'repeat' && key !== 'count') {
                throw new Error(`#pragma pio_sim: unexpected '${tokens[i]}' (${usage})`);
            }
            if (seen.has(key)) throw new Error(`#pragma pio_sim: '${key}' given twice`);
            seen.add(key);
            const v = num(tokens[i + 1], key);
            if (key !== 'delay' && v < 1) throw new Error(`#pragma pio_sim: ${key} must be at least 1`);
            if (v < 0) throw new Error(`#pragma pio_sim: ${key} must not be negative`);
            ev[key] = v;
        }
        if (ev.count !== null && ev.repeat === null) {
            throw new Error(`#pragma pio_sim: 'count' needs 'repeat' (${usage})`);
        }
        irqEvents.push(ev);
    }

    // config: state machine settings that pioasm directives cannot express
    // (pin bases, JMP pin) or that the C setup code would normally apply.
    // They are loaded into the simulator's controls on assemble.
    // config [sm <n>] <name> <value> ...: with `sm <n>`, the settings are
    // for that state machine only, e.g. one program on several state
    // machines with different pins.
    pragmaConfig(tokens, config, seen, out) {
        if ((tokens[1] || '').toLowerCase() === 'sm') {
            if (!/^[0-3]$/.test(tokens[2] || '')) {
                throw new Error(`#pragma pio_sim: state machine number must be 0-3, got '${tokens[2] || ''}'`);
            }
            const sm = parseInt(tokens[2]);
            if (!out.smConfig[sm]) out.smConfig[sm] = { config: {}, seen: new Set() };
            this.pragmaConfig(['config', ...tokens.slice(3)], out.smConfig[sm].config, out.smConfig[sm].seen, out);
            return;
        }
        const names = Object.keys(PioAssembler.CONFIG_PRAGMA);
        const usage = `expected '; #pragma pio_sim config [sm <n>] <name> <value> ...' with names: ${names.join(', ')}`;
        if (tokens.length < 3 || tokens.length % 2 !== 1) {
            throw new Error(`#pragma pio_sim: config takes name/value pairs (${usage})`);
        }
        for (let i = 1; i < tokens.length; i += 2) {
            const name = tokens[i].toLowerCase();
            const def = PioAssembler.CONFIG_PRAGMA[name];
            if (!def) throw new Error(`#pragma pio_sim: unknown config name '${tokens[i]}' (${usage})`);
            if (seen.has(name)) throw new Error(`#pragma pio_sim: config '${name}' given twice`);
            seen.add(name);

            const raw = tokens[i + 1];
            let value;
            if (def.values) {
                const k = raw.toLowerCase();
                if (!Object.prototype.hasOwnProperty.call(def.values, k)) {
                    throw new Error(`#pragma pio_sim: config ${name} must be one of ${Object.keys(def.values).join(', ')}, got '${raw}'`);
                }
                value = def.values[k];
            } else if (def.decimal) {
                if (!/^\d+(\.\d+)?$/.test(raw)) {
                    throw new Error(`#pragma pio_sim: config ${name} must be a number such as 2 or 2.5, got '${raw}'`);
                }
                value = Math.floor(parseFloat(raw) * 256) / 256;
                if (value < def.min || value > def.max) {
                    throw new Error(`#pragma pio_sim: config ${name} must be ${def.min}-${def.max}, got ${raw}`);
                }
            } else {
                value = this.pragmaNumber(raw, `config ${name}`, usage);
                if (value < def.min || value > def.max) {
                    throw new Error(`#pragma pio_sim: config ${name} must be ${def.min}-${def.max}, got ${value}`);
                }
            }
            config[def.key] = value;
        }
    }
}

// Names accepted by `; #pragma pio_sim config`, and the setting each maps to.
PioAssembler.CONFIG_PRAGMA = {
    out_base: { key: 'outBase', min: 0, max: 31 },
    out_count: { key: 'outCount', min: 0, max: 32 },
    set_base: { key: 'setBase', min: 0, max: 31 },
    set_count: { key: 'setCount', min: 0, max: 5 },
    sideset_base: { key: 'sidesetBase', min: 0, max: 31 },
    in_base: { key: 'inBase', min: 0, max: 31 },
    in_count: { key: 'inCount', min: 1, max: 32 },
    jmp_pin: { key: 'jmpPin', min: 0, max: 31 },
    in_shift: { key: 'inShiftDir', values: { left: 'left', right: 'right' } },
    out_shift: { key: 'outShiftDir', values: { left: 'left', right: 'right' } },
    autopush: { key: 'autoPush', values: { on: true, off: false } },
    push_thresh: { key: 'pushThresh', min: 1, max: 32 },
    autopull: { key: 'autoPull', values: { on: true, off: false } },
    pull_thresh: { key: 'pullThresh', min: 1, max: 32 },
    status_sel: { key: 'statusSel', values: { tx: 0, rx: 1, irq: 2 } },
    status_n: { key: 'statusN', min: 0, max: 31 },
    fifo: { key: 'fifoMode', values: { txrx: 'txrx', tx: 'tx', rx: 'rx', txput: 'txput', txget: 'txget', putget: 'putget' } },
    clkdiv: { key: 'clkDiv', min: 1, max: 65535, decimal: true }
};

// Assembler state that belongs to one program.
PioAssembler.PROGRAM_FIELDS = [
    'programName', 'programLine', 'symbols', 'pragmas', 'items', 'sideset', 'wrapTarget', 'wrap',
    'origin', 'fifo', 'dirIn', 'dirOut', 'dirSet', 'movStatus', 'clockDiv', 'pioVersion'
];
