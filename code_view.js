// Source editor with a gutter: line numbers, instruction addresses,
// breakpoints and the state machines' PCs, all against the source lines.
//
// The text is edited in a plain <textarea>. A layer behind it, with the same
// font and line height, colours whole lines (current PC, breakpoints, an
// assembler error); the gutter on the left scrolls with it. No wrapping, so
// one source line is always one row.
class CodeView {
    constructor(textarea, { onBreakpointsChanged, onSelectSm } = {}) {
        this.input = textarea;
        this.onBreakpointsChanged = onBreakpointsChanged || (() => {});
        this.onSelectSm = onSelectSm || (() => {});

        this.lineToAddr = new Map();    // source line -> instruction address
        this.addrToLine = new Map();
        this.lineNotes = new Map();     // source line -> note shown after the text
        this.breakpointLines = new Set();
        this.pcMarks = [];              // [{ sm, line }]
        this.pcLine = null;             // selected state machine's line
        this.errorLine = null;
        this.warningLines = new Set();
        this.stale = false;             // source edited since the last assemble

        // Build the view around the textarea.
        const view = document.createElement('div');
        view.className = 'code-view';
        textarea.parentNode.insertBefore(view, textarea);

        this.gutter = document.createElement('div');
        this.gutter.className = 'code-gutter';
        this.gutterInner = document.createElement('div');
        this.gutterInner.className = 'code-gutter-inner';
        this.gutter.appendChild(this.gutterInner);

        const main = document.createElement('div');
        main.className = 'code-main';
        this.layer = document.createElement('div');
        this.layer.className = 'code-layer';
        this.layerInner = document.createElement('div');
        this.layerInner.className = 'code-layer-inner';
        this.layer.appendChild(this.layerInner);
        main.appendChild(this.layer);
        main.appendChild(textarea);
        textarea.classList.add('code-input');
        textarea.setAttribute('wrap', 'off');

        view.appendChild(this.gutter);
        view.appendChild(main);

        this.note = document.createElement('div');
        this.note.className = 'code-note';
        view.parentNode.insertBefore(this.note, view.nextSibling);

        this.gutterRows = [];
        this.layerRows = [];
        this.lineCount = 0;

        textarea.addEventListener('scroll', () => this.syncScroll());
        textarea.addEventListener('input', () => this.onInput());
        this.render();
    }

    get value() {
        return this.input.value;
    }

    set value(text) {
        this.input.value = text;
        this.lineCount = this.lines().length;
        this.render();
    }

    lines() {
        return this.input.value.replace(/\r/g, '').split('\n');
    }

    // ---- state from the simulator ------------------------------------------

    // After a successful assemble: which source line holds which address.
    setAssembly(program) {
        this.lineToAddr.clear();
        this.addrToLine.clear();
        this.lineNotes.clear();
        for (const p of program.programs) {
            for (const m of p.programMap) {
                this.lineToAddr.set(m.line, m.pc);
                this.addrToLine.set(m.pc, m.line);
            }
            if (program.programs.length > 1 && p.line > 0) {
                const runs = program.smPrograms.map((idx, i) => program.programs[idx] === p ? `SM${i}` : null).filter(x => x);
                this.lineNotes.set(p.line, `  ◂ ${runs.length ? runs.join(', ') : 'not running'}, address ${p.offset}-${p.offset + p.length - 1}`);
            }
        }
        // Breakpoints only make sense on instructions.
        for (const line of [...this.breakpointLines]) {
            if (!this.lineToAddr.has(line)) this.breakpointLines.delete(line);
        }
        this.stale = false;
        this.errorLine = null;
        this.render();
        this.onBreakpointsChanged();
    }

    // Highlight the line of an assembler error and put the caret on it.
    setError(line) {
        this.errorLine = line;
        this.render();
        if (!line) return;
        const lines = this.lines();
        let start = 0;
        for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
        const end = start + (lines[line - 1] || '').length;
        this.input.focus({ preventScroll: true });
        this.input.setSelectionRange(start, end);
        this.scrollToLine(line);
    }

    // Lines with a warning, marked in the gutter.
    setWarnings(lines) {
        this.warningLines = new Set(lines);
        this.renderMarks();
    }

    // Addresses of the lines with a breakpoint, for the run loop.
    breakpointAddrs() {
        const out = new Set();
        if (this.stale) return out;
        for (const line of this.breakpointLines) {
            if (this.lineToAddr.has(line)) out.add(this.lineToAddr.get(line));
        }
        return out;
    }

    // Each running state machine's PC, and the selected one's.
    setPcs(marks, selectedSm, follow) {
        this.pcMarks = marks.map(m => ({ sm: m.sm, line: this.addrToLine.get(m.pc) })).filter(m => m.line !== undefined);
        const sel = this.pcMarks.find(m => m.sm === selectedSm);
        this.pcLine = sel ? sel.line : null;
        this.renderMarks();
        if (follow && this.pcLine && !this.stale && document.activeElement !== this.input) {
            this.scrollToLine(this.pcLine, true);
        }
    }

    toggleBreakpoint(line) {
        // When the assembly is current, only instruction lines take one.
        if (!this.stale && !this.lineToAddr.has(line)) return;
        if (this.breakpointLines.has(line)) this.breakpointLines.delete(line);
        else this.breakpointLines.add(line);
        this.renderMarks();
        this.onBreakpointsChanged();
    }

    // ---- editing -----------------------------------------------------------

    onInput() {
        // Keep breakpoints on their text when lines are added or removed
        // above them. The edit is around the caret.
        const count = this.lines().length;
        const d = count - this.lineCount;
        if (d !== 0) {
            const caret = this.input.value.slice(0, this.input.selectionStart).split('\n').length;
            const moved = new Set();
            for (const line of this.breakpointLines) {
                if (d > 0 && line > caret - d) moved.add(line + d);
                else if (d < 0 && line > caret && line <= caret - d) continue;  // merged away
                else if (d < 0 && line > caret - d) moved.add(line + d);
                else moved.add(line);
            }
            this.breakpointLines = moved;
            if (this.errorLine && this.errorLine > caret) this.errorLine = null;
        }
        this.lineCount = count;
        if (!this.stale) {
            this.stale = true;
            this.onBreakpointsChanged();
        }
        this.render();
    }

    // ---- drawing -----------------------------------------------------------

    render() {
        const lines = this.lines();
        this.lineCount = lines.length;
        this.gutterInner.textContent = '';
        this.layerInner.textContent = '';
        this.gutterRows = [];
        this.layerRows = [];
        lines.forEach((text, i) => {
            const line = i + 1;
            const g = document.createElement('div');
            g.className = 'g-row';
            const bp = document.createElement('span');
            bp.className = 'g-bp';
            const num = document.createElement('span');
            num.className = 'g-line';
            num.textContent = line;
            const addr = document.createElement('span');
            addr.className = 'g-addr';
            if (!this.stale && this.lineToAddr.has(line)) {
                addr.textContent = String(this.lineToAddr.get(line)).padStart(2, '0');
                g.classList.add('has-addr');
                g.title = `Line ${line}, address ${this.lineToAddr.get(line)}. Click to toggle a breakpoint.`;
            }
            const pcs = document.createElement('span');
            pcs.className = 'g-pcs';
            for (const el of [bp, num, addr]) {
                el.addEventListener('mousedown', e => e.preventDefault());
                el.addEventListener('click', () => this.toggleBreakpoint(line));
            }
            g.append(bp, num, addr, pcs);
            this.gutterInner.appendChild(g);
            this.gutterRows.push(g);

            const l = document.createElement('div');
            l.className = 'l-row';
            if (this.lineNotes.has(line) && !this.stale) {
                const ghost = document.createElement('span');
                ghost.className = 'l-ghost';
                ghost.textContent = text;
                const note = document.createElement('span');
                note.className = 'l-note';
                note.textContent = this.lineNotes.get(line);
                l.append(ghost, note);
            } else {
                l.textContent = '​';
            }
            this.layerInner.appendChild(l);
            this.layerRows.push(l);
        });
        this.note.textContent = this.stale
            ? 'Edited since the last Assemble: addresses, PCs and breakpoints apply again after Assemble & Reset.'
            : '';
        this.note.style.display = this.stale ? '' : 'none';
        this.renderMarks();
        this.syncScroll();
    }

    renderMarks() {
        this.gutterRows.forEach((g, i) => {
            const line = i + 1;
            g.classList.toggle('bp', this.breakpointLines.has(line));
            g.classList.toggle('pc', !this.stale && line === this.pcLine);
            const pcs = g.querySelector('.g-pcs');
            pcs.textContent = '';
        });
        // Every running state machine's line in its own colour (stripes when
        // several share a line); the selected one is also marked at the left.
        const several = this.pcMarks.length > 1;
        const atLine = new Map();
        if (!this.stale) {
            for (const m of this.pcMarks) {
                if (!atLine.has(m.line)) atLine.set(m.line, []);
                atLine.get(m.line).push(m.sm);
            }
        }
        this.layerRows.forEach((l, i) => {
            const line = i + 1;
            const sms = atLine.get(line) || [];
            l.classList.toggle('bp', this.breakpointLines.has(line));
            l.classList.toggle('pc', !several && sms.length > 0);
            l.classList.toggle('pc-sel', several && !this.stale && line === this.pcLine);
            l.classList.toggle('error', line === this.errorLine);
            l.classList.toggle('warning', !this.stale && this.warningLines.has(line));
            if (several && sms.length > 0) {
                const colours = sms.map(sm => CodeView.LINE_COLOURS[sm]);
                l.style.background = colours.length === 1 ? colours[0]
                    : `repeating-linear-gradient(135deg, ${colours.map((c, k) => `${c} ${k * 8}px ${(k + 1) * 8}px`).join(', ')})`;
            } else {
                l.style.background = '';
            }
        });
        if (this.stale) return;
        // A mark per state machine when several run, coloured per SM.
        if (this.pcMarks.length > 1) {
            for (const m of this.pcMarks) {
                const g = this.gutterRows[m.line - 1];
                if (!g) continue;
                const mark = document.createElement('span');
                mark.className = `g-pc sm${m.sm}`;
                mark.textContent = m.sm;
                mark.title = `SM${m.sm} is here. Click to show SM${m.sm}.`;
                mark.addEventListener('mousedown', e => e.preventDefault());
                mark.addEventListener('click', () => this.onSelectSm(m.sm));
                g.querySelector('.g-pcs').appendChild(mark);
            }
        }
    }

    syncScroll() {
        const top = this.input.scrollTop;
        const left = this.input.scrollLeft;
        this.gutterInner.style.transform = `translateY(${-top}px)`;
        this.layerInner.style.transform = `translate(${-left}px, ${-top}px)`;
    }

    rowHeight() {
        const row = this.layerRows[0];
        return row ? row.offsetHeight || 20 : 20;
    }

    // Bring a line into view; `ifNeeded` leaves it alone when visible.
    scrollToLine(line, ifNeeded = false) {
        const h = this.rowHeight();
        const top = (line - 1) * h;
        const view = this.input.clientHeight - 2 * h;
        if (ifNeeded && top >= this.input.scrollTop && top <= this.input.scrollTop + view) return;
        this.input.scrollTop = Math.max(0, top - this.input.clientHeight / 3);
        this.syncScroll();
    }
}

// Background of a state machine's current line on the dark editor, one per
// state machine (the same hues as its marks).
CodeView.LINE_COLOURS = ['#1d4f7c', '#2b5a2e', '#6a4a14', '#4f2d5f'];
