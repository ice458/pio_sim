const assembler = new PioAssembler();
const emulator = new PioEmulator();

const STORAGE_KEY = 'pio_sim_code_v1';

const exampleSelect = document.getElementById('example-select');
const codeEditor = document.getElementById('code-editor');
const btnAssemble = document.getElementById('btn-assemble');
const btnStep = document.getElementById('btn-step');
const btnRunStop = document.getElementById('btn-run-stop');
const btnReset = document.getElementById('btn-reset');
const errorMessage = document.getElementById('error-message');

const regPc = document.getElementById('reg-pc');
const regCycles = document.getElementById('reg-cycles');
const regSmStatus = document.getElementById('reg-sm-status');
const warningMessage = document.getElementById('warning-message');
const regClock = document.getElementById('reg-clock');
const regX = document.getElementById('reg-x');
const regY = document.getElementById('reg-y');
const regOsr = document.getElementById('reg-osr');
const regOsrCount = document.getElementById('reg-osr-count');
const regIsr = document.getElementById('reg-isr');
const regIsrCount = document.getElementById('reg-isr-count');
const statusIndicator = document.getElementById('status-indicator');

const txInput = document.getElementById('tx-input');
const btnPutTx = document.getElementById('btn-put-tx');
const txPutResult = document.getElementById('tx-put-result');
const txFifoList = document.getElementById('tx-fifo-list');
const rxFifoList = document.getElementById('rx-fifo-list');
const btnGetRx = document.getElementById('btn-get-rx');
const rxGetResult = document.getElementById('rx-get-result');

const rxFifoTitle = document.getElementById('rx-fifo-title');
const txDmaNote = document.getElementById('tx-dma-note');
const rxDmaNote = document.getElementById('rx-dma-note');
const txSmSide = document.getElementById('tx-sm-side');
const rxSmSide = document.getElementById('rx-sm-side');
const rxSmEnd = document.getElementById('rx-sm-end');

// A FIFO as one slot per entry, oldest first: the words in it, then empty
// slots up to its depth. The slots are kept and only their text changes.
function setFifoSlots(list, words, capacity) {
    while (list.children.length < capacity) list.appendChild(document.createElement('li'));
    while (list.children.length > capacity) list.lastChild.remove();
    for (let i = 0; i < capacity; i++) {
        const li = list.children[i];
        const text = i < words.length ? `0x${(words[i] >>> 0).toString(16).toUpperCase()}` : '';
        if (li.textContent !== text) li.textContent = text;
        li.classList.toggle('empty', i >= words.length);
    }
}

// A word read from a FIFO, with its character when it is one.
function fifoWordText(v) {
    const hex = '0x' + (v >>> 0).toString(16).toUpperCase();
    const named = { 9: '\\t', 10: '\\n', 13: '\\r' };
    if (named[v]) return `${hex} '${named[v]}'`;
    if (v >= 0x20 && v < 0x7f) return `${hex} '${String.fromCharCode(v)}'`;
    return hex;
}
const rxGetControls = document.getElementById('rx-get-controls');
const rxRegControls = document.getElementById('rx-reg-controls');
const rxRegIndex = document.getElementById('rx-reg-index');
const rxRegInput = document.getElementById('rx-reg-input');
const btnWriteRxReg = document.getElementById('btn-write-rx-reg');
const rxRegNote = document.getElementById('rx-reg-note');

const cfgOutBase = document.getElementById('cfg-out-base');
const cfgOutCount = document.getElementById('cfg-out-count');
const cfgOutCountHint = document.getElementById('cfg-out-count-hint');
const cfgSetBase = document.getElementById('cfg-set-base');
const cfgSetCount = document.getElementById('cfg-set-count');
const cfgSidesetBase = document.getElementById('cfg-sideset-base');
const cfgInBase = document.getElementById('cfg-in-base');
const cfgInCount = document.getElementById('cfg-in-count');
const cfgJmpPin = document.getElementById('cfg-jmp-pin');
const cfgFifoMode = document.getElementById('cfg-fifo-mode');
const cfgClkDiv = document.getElementById('cfg-clkdiv');
const cfgClkDivNote = document.getElementById('cfg-clkdiv-note');
const regSysclk = document.getElementById('reg-sysclk');
const cfgChip = document.getElementById('cfg-chip');
const CHIP_KEY = 'pio_sim_chip_v1';
try {
    const savedChip = localStorage.getItem(CHIP_KEY);
    if (savedChip === 'rp2040' || savedChip === 'rp2350') cfgChip.value = savedChip;
} catch (e) {
    // localStorage unavailable — keep the default.
}
emulator.chip = cfgChip.value;
cfgChip.addEventListener('change', () => {
    emulator.chip = cfgChip.value;
    try { localStorage.setItem(CHIP_KEY, cfgChip.value); } catch (e) { /* ignore */ }
    if (lastProgram) showWarnings(lastProgram);
    updateUI();
});

// Features the RP2040 does not have, in what was assembled.
function rp2350Only(program) {
    const found = new Set();
    for (const instr of program.memory) {
        if (!instr) continue;
        if (instr.prev || instr.next) found.add('irq prev/next');
        if (instr.type === 'WAIT' && instr.source === 'jmppin') found.add('wait jmppin');
        if (instr.type === 'MOV' && instr.dest === 'pindirs') found.add('mov pindirs');
        if (instr.type === 'MOV' && (instr.dest === 'rxfifo' || instr.src === 'rxfifo')) found.add('mov rxfifo[]');
    }
    for (const c of program.smConfigs) {
        if (!c) continue;
        if (c.statusSel === 2) found.add('mov status on an IRQ flag');
        if (['txput', 'txget', 'putget'].includes(c.fifoMode)) found.add(`.fifo ${c.fifoMode}`);
        if (c.inCount !== undefined && c.inCount !== 32) found.add('IN_COUNT');
    }
    return [...found];
}

function showWarnings(program) {
    const lines = program.warnings.map(w => `Line ${w.line}: warning: ${w.message}`);
    const only = cfgChip.value === 'rp2040' ? rp2350Only(program) : [];
    if (only.length) lines.push(`warning: Chip is RP2040, but the program uses RP2350 features: ${only.join(', ')}`);
    warningMessage.textContent = lines.join('\n');
}
const latencyNote = document.getElementById('latency-note');
const cfgInShiftDir = document.getElementById('cfg-in-shift-dir');
const cfgOutShiftDir = document.getElementById('cfg-out-shift-dir');
const cfgAutoPush = document.getElementById('cfg-auto-push');
const cfgPushThresh = document.getElementById('cfg-push-thresh');
const cfgAutoPull = document.getElementById('cfg-auto-pull');
const cfgPullThresh = document.getElementById('cfg-pull-thresh');
const cfgStatusSel = document.getElementById('cfg-status-sel');
const cfgStatusN = document.getElementById('cfg-status-n');

const gpioHexVal = document.getElementById('gpio-hex-val');
const gpioIndicators = document.getElementById('gpio-indicators');
const gpioFf1HexVal = document.getElementById('gpio-ff1-hex-val');
const gpioFf2HexVal = document.getElementById('gpio-ff2-hex-val');
const gpioSeenHexVal = document.getElementById('gpio-seen-hex-val');
const gpioFf1Row = gpioFf1HexVal.parentElement;
const gpioFf2Row = gpioFf2HexVal.parentElement;
const btnBypassAll = document.getElementById('btn-bypass-all');
const btnEngageSyncAll = document.getElementById('btn-engage-sync-all');

const irqFlags = document.getElementById('irq-flags');

const canvas = document.getElementById('timing-chart');
const ctx = canvas.getContext('2d');
const timingChartTitle = document.getElementById('timing-chart-title');
const timingPinSelector = document.getElementById('timing-pin-selector');
const timingRegSelector = document.getElementById('timing-reg-selector');
const selectedTimingPins = new Set();
const selectedTimingRegs = new Set();
const timingIrqSelector = document.getElementById('timing-irq-selector');
// IRQ rows: the flags the program uses are shown by default; a click on a
// flag's button overrides that, to show or hide it.
const timingIrqOverride = new Map();    // flag -> shown
const timingIrqButtons = [];
let timingCursorX = null;   // mouse x on the timing chart, in canvas pixels
const timingSpan = document.getElementById('timing-span');

const TIMING_REGS = [
    { key: 'pc',  label: 'PC',  format: v => v.toString() },
    { key: 'x',   label: 'X',   format: v => '0x' + (v >>> 0).toString(16).toUpperCase() },
    { key: 'y',   label: 'Y',   format: v => '0x' + (v >>> 0).toString(16).toUpperCase() },
    { key: 'osr', label: 'OSR', format: v => '0x' + (v >>> 0).toString(16).toUpperCase() },
    { key: 'isr', label: 'ISR', format: v => '0x' + (v >>> 0).toString(16).toUpperCase() }
];

// The state machine whose details and settings are shown.
let sel = 0;
const cur = () => emulator.sms[sel];
const smSummaryBody = document.querySelector('#sm-summary tbody');
const smTabContainers = [document.getElementById('sm-tabs-state'), document.getElementById('sm-tabs-config')];
let lastProgram = null;

let runInterval = null;
let runMode = null; // 'interval' | 'raf'
// Breakpoints are set on source lines in the editor's gutter; this is
// their instruction addresses for the run loop.
let breakpoints = new Set();
const codeView = new CodeView(codeEditor, {
    onBreakpointsChanged: () => { breakpoints = codeView.breakpointAddrs(); },
    onSelectSm: i => selectSm(i)
});
// Source text of each instruction address, for the state machine summary.
let addrText = new Map();
let lastRxMessage = 'Not read yet';
let lastTxMessage = 'Nothing put yet';

for (let i = 31; i >= 0; i--) {
    const bit = document.createElement('div');
    bit.className = 'gpio-bit';
    bit.id = `gpio-bit-${i}`;
    bit.textContent = i;
    bit.title = `GPIO ${i}`;

    bit.addEventListener('click', (e) => {
        if (e.altKey) {
            emulator.inputSyncBypass ^= (1 << i);
            emulator.inputSyncBypass >>>= 0;
        } else if (e.shiftKey) {
            emulator.pindirs ^= (1 << i);
        } else {
            emulator.inputs ^= (1 << i);
            // Pins driven by a `#pragma pio_sim` stimulus keep their waveform.
            emulator.applyStimuli();
        }
        updateUI();
    });

    bit.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        emulator.pindirs ^= (1 << i);
        updateUI();
    });

    gpioIndicators.appendChild(bit);
}

for (let i = 0; i < 8; i++) {
    const flag = document.createElement('div');
    flag.className = 'irq-flag';
    flag.id = `irq-flag-${i}`;
    flag.textContent = `IRQ ${i}`;

    flag.addEventListener('click', () => {
        emulator.irq ^= (1 << i);
        updateUI();
    });

    irqFlags.appendChild(flag);
}

for (let i = 31; i >= 0; i--) {
    const bit = document.createElement('div');
    bit.className = 'gpio-bit';
    bit.textContent = i;
    bit.title = `Toggle GPIO ${i} in Timing Chart`;
    
    bit.addEventListener('click', () => {
        if (selectedTimingPins.has(i)) {
            selectedTimingPins.delete(i);
            bit.classList.remove('selected');
        } else {
            selectedTimingPins.add(i);
            bit.classList.add('selected');
        }
        drawTimingChart();
    });

    timingPinSelector.appendChild(bit);
}

for (const reg of TIMING_REGS) {
    const btn = document.createElement('div');
    btn.className = 'reg-toggle';
    btn.textContent = reg.label;
    btn.title = `Toggle ${reg.label} in Timing Chart`;
    btn.addEventListener('click', () => {
        if (selectedTimingRegs.has(reg.key)) {
            selectedTimingRegs.delete(reg.key);
            btn.classList.remove('selected');
        } else {
            selectedTimingRegs.add(reg.key);
            btn.classList.add('selected');
        }
        drawTimingChart();
    });
    timingRegSelector.appendChild(btn);
}

// IRQ flags. A button is lit while its flag is shown, whether by default or
// by a click; drawTimingChart keeps them in step.
for (let i = 0; i < 8; i++) {
    const btn = document.createElement('div');
    btn.className = 'reg-toggle';
    btn.textContent = `IRQ ${i}`;
    btn.title = `Toggle IRQ ${i} in Timing Chart`;
    btn.addEventListener('click', () => {
        timingIrqOverride.set(i, !btn.classList.contains('selected'));
        drawTimingChart();
    });
    timingIrqSelector.appendChild(btn);
    timingIrqButtons.push(btn);
}

timingSpan.addEventListener('change', () => drawTimingChart());

// ---- the two panes ----------------------------------------------------------

const mainContent = document.querySelector('.main-content');
const editorPane = document.querySelector('.editor-section');
const statusPane = document.querySelector('.status-section');
const paneSplitter = document.getElementById('pane-splitter');
const SPLIT_KEY = 'pio_sim_split_v1';
const SPLIT_MIN_LEFT = 300;     // px: the editor's buttons in one row
const SPLIT_MIN_RIGHT = 420;    // px: the State panel's tabs and FIFOs

// Help sections: the header keeps the row of titles; what one opens shows
// at the top of the State pane, beside the editor and not over it, so the
// pragma reference can be read while writing the program. One at a time;
// it stays until closed (its title again, or its x).
{
    const dock = document.createElement('div');
    dock.className = 'help-dock';
    statusPane.insertBefore(dock, statusPane.firstChild);
    const helps = [...document.querySelectorAll('.header-links details')];
    const show = () => {
        for (const d of helps) d.helpPanel.style.display = d.open ? '' : 'none';
    };
    const twoColumns = window.matchMedia('(min-width: 901px)');
    for (const d of helps) {
        const summary = d.querySelector('summary');
        const panel = d.querySelector('.help-panel');
        d.helpPanel = panel;
        // Say where it opens, before and after: it is not under the title.
        summary.title = 'Opens beside the editor, at the top of the State pane';
        // The panel carries the title it was opened from, and a close button.
        const head = document.createElement('div');
        head.className = 'help-title';
        head.textContent = summary.textContent;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'help-close';
        close.textContent = '×';
        close.title = 'Close';
        close.addEventListener('click', () => { d.open = false; show(); });
        panel.insertBefore(head, panel.firstChild);
        panel.insertBefore(close, panel.firstChild);
        dock.appendChild(panel);
        // On the click itself (the toggle event comes later, after any
        // further click), so the newest one is the one left open.
        summary.addEventListener('click', () => {
            if (d.open) return;
            for (const o of helps) if (o !== d) o.open = false;
            statusPane.scrollTop = 0;
        });
        d.addEventListener('toggle', () => {
            show();
            if (!d.open) return;
            summary.dataset.where = twoColumns.matches ? '→ shown on the right' : '↓ shown below the editor';
            // A flash where it opened draws the eye there.
            panel.classList.remove('flash');
            void panel.offsetWidth;
            panel.classList.add('flash');
            if (!twoColumns.matches) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
    show();
}

// The editor's share of the width, a fraction of the two panes; null for
// the default. The timing chart is redrawn for its new width.
let chartRedraw = 0;
function setSplit(frac) {
    if (frac === null) mainContent.style.removeProperty('--split');
    else mainContent.style.setProperty('--split', `${(frac * 100).toFixed(2)}%`);
    if (!chartRedraw) {
        chartRedraw = requestAnimationFrame(() => { chartRedraw = 0; drawTimingChart(); });
    }
}

function clampSplit(frac) {
    const w = mainContent.getBoundingClientRect().width;
    if (!w) return frac;
    const lo = SPLIT_MIN_LEFT / w;
    const hi = (w - paneSplitter.offsetWidth - SPLIT_MIN_RIGHT) / w;
    return Math.max(lo, Math.min(hi, frac));
}

function saveSplit(frac) {
    try {
        if (frac === null) localStorage.removeItem(SPLIT_KEY);
        else localStorage.setItem(SPLIT_KEY, frac.toFixed(4));
    } catch (e) {
        // Not stored; the split still applies until the page is left.
    }
}

try {
    const saved = parseFloat(localStorage.getItem(SPLIT_KEY));
    if (saved > 0.1 && saved < 0.9) setSplit(clampSplit(saved));
} catch (e) {
    // No storage: the default split.
}

paneSplitter.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    paneSplitter.setPointerCapture(e.pointerId);
    paneSplitter.classList.add('dragging');
    document.body.classList.add('resizing');
    let frac = null;
    const move = ev => {
        const r = mainContent.getBoundingClientRect();
        frac = clampSplit((ev.clientX - r.left - paneSplitter.offsetWidth / 2) / r.width);
        setSplit(frac);
    };
    const end = () => {
        paneSplitter.removeEventListener('pointermove', move);
        paneSplitter.removeEventListener('pointerup', end);
        paneSplitter.removeEventListener('pointercancel', end);
        paneSplitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        if (frac !== null) saveSplit(frac);
    };
    paneSplitter.addEventListener('pointermove', move);
    paneSplitter.addEventListener('pointerup', end);
    paneSplitter.addEventListener('pointercancel', end);
});

paneSplitter.addEventListener('dblclick', () => {
    setSplit(null);
    saveSplit(null);
});

// Arrow keys move it too, 2 % a press.
paneSplitter.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const r = mainContent.getBoundingClientRect();
    const now = editorPane.getBoundingClientRect().width / r.width;
    const frac = clampSplit(now + (e.key === 'ArrowLeft' ? -0.02 : 0.02));
    setSplit(frac);
    saveSplit(frac);
});

// "More below" at the foot of each pane while there is more to scroll to,
// so controls further down are not missed. A click scrolls on.
for (const pane of [editorPane, statusPane]) {
    const more = document.createElement('div');
    more.className = 'pane-more';
    const inner = document.createElement('div');
    inner.className = 'pane-more-inner';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '▼ More below';
    btn.title = 'This pane scrolls: more controls further down';
    btn.addEventListener('click', () => pane.scrollBy({ top: pane.clientHeight * 0.8, behavior: 'smooth' }));
    inner.appendChild(btn);
    more.appendChild(inner);
    pane.appendChild(more);
    const update = () => {
        const scrolls = getComputedStyle(pane).overflowY === 'auto';
        more.classList.toggle('show', scrolls && pane.scrollTop + pane.clientHeight < pane.scrollHeight - 8);
    };
    pane.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    for (const child of pane.children) ro.observe(child);
}
// The canvas matches its shown width, which follows the window.
window.addEventListener('resize', () => drawTimingChart());

btnAssemble.addEventListener('click', assembleAndReset);
btnStep.addEventListener('click', step);
btnRunStop.addEventListener('click', toggleRunStop);
btnReset.addEventListener('click', reset);
// Asking to execute means wanting to see where: the editor follows the PC
// again if it had stopped because the user scrolled away. Stopping a run
// does not: that is often to look at what they scrolled to.
for (const b of [btnAssemble, btnStep, btnReset]) {
    b.addEventListener('click', () => codeView.resumeFollow());
}
btnRunStop.addEventListener('click', () => {
    if (btnRunStop.textContent === 'Stop') codeView.resumeFollow();
});

btnBypassAll.addEventListener('click', () => {
    emulator.inputSyncBypass = 0xFFFFFFFF;
    updateUI();
});
btnEngageSyncAll.addEventListener('click', () => {
    emulator.inputSyncBypass = 0;
    updateUI();
});

document.getElementById('run-speed').addEventListener('change', () => {
    if (runInterval) {
        stop();
        run();
    }
});

// Examples. Each one carries its settings in '; #pragma pio_sim' lines, so
// it runs the same when pasted in. `group` and `label` build the menu.
const examples = {
    blink: {
        group: 'Basics', label: 'Blink (set, delay)',
        code: `; Blink: toggle GPIO 0 with SET.
; [n] after an instruction waits n more cycles, so each level lasts
; 1 + 3 = 4 cycles. At the end, .wrap goes back to .wrap_target without
; spending a cycle on a jmp.
;
; Settings a C program would make with sm_config_set_set_pins():
; #pragma pio_sim config set_base 0 set_count 1

.program blink
    set pindirs, 1      ; GPIO 0 as an output (pins start as inputs)
.wrap_target
    set pins, 1 [3]     ; high for 4 cycles
    set pins, 0 [3]     ; low for 4 cycles
.wrap`
    },
    pwm: {
        group: 'Basics', label: 'PWM (side-set, FIFO)',
        code: `; PWM on GPIO 0, the level coming from the TX FIFO.
; ISR holds the period, set once at the start. Each PWM period, Y counts
; down from the period to 0; the pin goes high when Y reaches the level
; in X and stays high to the end. So it is high for level + 1 of every
; period + 1 counts. Side-set drives the pin without a cycle of its own.
;
; pull noblock with an empty FIFO copies X to the OSR, so the last level
; stays until a new one arrives.
;
; #pragma pio_sim config sideset_base 0 set_base 0 set_count 1
; DMA writes the TX FIFO, as a C program would set it up: the period
; (7), then levels 1, 3 and 6 for two PWM periods each.
; #pragma pio_sim dma put 7  1 1  3 3  6 6

.program pwm
.side_set 1 opt
    set pindirs, 1          ; GPIO 0 as an output
    pull block              ; the period from the FIFO ...
    out isr, 32             ; ... kept in ISR
.wrap_target
    pull noblock    side 0  ; next level (or keep the last), pin low
    mov x, osr              ; X = level
    mov y, isr              ; Y = period
count:
    jmp x!=y skip           ; Y not at the level: pin unchanged
    jmp counted     side 1  ; Y reached the level: pin high
skip:
    nop                     ; same 2 cycles as the other path
counted:
    jmp y-- count           ; until Y passes 0
.wrap`
    },
    stimulus: {
        group: 'Basics', label: 'Input waveform (#pragma pio_sim pin)',
        code: `; Copy GPIO 5 to GPIO 0, with GPIO 5 driven by a test waveform.
; A pin pragma plays a signal from outside the chip, in system clocks:
;   pin <n> [<hi|low> delay <clocks>] <hi|low> <clocks> ... [count <n>]
;
; GPIO 5: low 7 clocks, high 3, repeating forever
; #pragma pio_sim pin 5 low 7 hi 3
;
; wait ... pin counts from in_base; set from set_base.
; #pragma pio_sim config set_base 0 set_count 1 in_base 5

.program follow
    set pindirs, 1  ; GPIO 0 as an output
.wrap_target
    wait 1 pin 0    ; wait for GPIO 5 (in_base + 0) to go high
    set pins, 1     ; copy it to GPIO 0
    wait 0 pin 0    ; and low again
    set pins, 0
.wrap

; GPIO 0 follows a few clocks late: an input passes the 2-flipflop
; synchroniser, and a pin write reaches the pad on the next clock.
; Alt+click GPIO 5 in the GPIO panel to bypass its synchroniser, or put
; '; #pragma pio_sim input_sync_bypass 5' in the source.`
    },
    pulse_width: {
        group: 'Basics', label: 'Pulse width meter (wait, jmp pin)',
        code: `; Measure how long each high pulse on GPIO 2 lasts and push the result.
; GPIO 0 is high while a pulse is being measured.
;
; X counts down from 0xFFFFFFFF once per 2-cycle loop while the pin is
; high, so ~X is the number of loops. The results, 1, 4 and 9 loops, are
; about half of each width less the few clocks spent seeing the edge.
;
; GPIO 2: pulses of 4, 10 and 20 clocks, 8 clocks apart.
; #pragma pio_sim pin 2 low delay 6 hi 4 low 8 hi 10 low 8 hi 20 low 8 count 1
; #pragma pio_sim config set_base 0 set_count 1 in_base 2 jmp_pin 2
; DMA reads the results from the RX FIFO; they show under it.
; #pragma pio_sim dma get

.program pulse_width
    set pindirs, 1      ; GPIO 0 as an output
.wrap_target
    wait 1 pin 0        ; rising edge on GPIO 2 (in_base + 0)
    set pins, 1         ; GPIO 0 high: measuring
    mov x, ~null        ; X = 0xFFFFFFFF
high:
    jmp x-- still       ; count one loop (always goes on to 'still')
still:
    jmp pin high        ; GPIO 2 (jmp_pin) still high: loop again
    set pins, 0         ; pulse over
    mov isr, ~x         ; ISR = loops counted
    push noblock        ; report it
.wrap`
    },
    uart: {
        group: 'Protocols', label: 'UART TX and RX (8N1)',
        code: `; UART, 8 data bits, no parity, 1 stop bit, LSB first.
; SM0 sends on GPIO 0; SM1 listens to the same pin and receives it back.
; One bit is 8 state machine cycles, so baud = sysclk / (8 * clkdiv):
; 150 MHz / (8 * 162.76) = 115200 baud.
;
; #pragma pio_sim config clkdiv 162.76

.program uart_tx
; #pragma pio_sim config set_base 0 set_count 1 out_base 0 out_count 1
; Bytes to send, written to the TX FIFO by DMA:
; #pragma pio_sim dma put "Hi!\\n"
    set pindirs, 1          ; GPIO 0 as an output
    set pins, 1             ; the line idles high
.wrap_target
    pull block              ; wait for a byte
    set x, 7                ; 8 data bits
    set pins, 0     [7]     ; start bit: low for 8 cycles
bit:
    out pins, 1     [6]     ; next bit, LSB first (out_shift right) ...
    jmp x-- bit             ; ... 1 + 6 + 1 = 8 cycles each
    set pins, 1     [7]     ; stop bit: high for 8 cycles (or more)
.wrap

.program uart_rx
; #pragma pio_sim config in_base 0 jmp_pin 0
; DMA reads the received bytes; they show under the RX FIFO.
; #pragma pio_sim dma get
    wait 1 pin 0            ; let the line go idle (high) first
.wrap_target
start:
    wait 0 pin 0            ; the falling edge of a start bit
    set x, 7        [10]    ; on to the middle of bit 0: the start bit
                            ; (8 cycles) and half a bit (4), the wait's
                            ; input delay included
bit:
    in pins, 1              ; sample a bit; ISR shifts right
    jmp x-- bit     [6]     ; 8 cycles a bit
    jmp pin ok              ; the stop bit must be high
    wait 1 pin 0            ; framing error: drop the byte, wait for idle
    jmp start
ok:
    in null, 24             ; move the byte from bits 31-24 to 7-0
    push                    ; the received byte
.wrap`
    },
    spi: {
        group: 'Protocols', label: 'SPI controller (mode 0)',
        code: `; SPI controller, mode 0 (CPOL 0, CPHA 0), 8-bit, MSB first.
; MOSI = GPIO 0, SCK = GPIO 1, MISO = GPIO 2.
; Data changes while SCK is low and is sampled on the rising edge; both
; sides sample at once, so every byte sent also receives one.
; The same two-instruction loop as spi.pio in pico-examples.
;
; Autopull and autopush every 8 bits; the loop never pulls or pushes
; itself. With nothing to send, OUT stalls and SCK stays low.
; #pragma pio_sim config out_base 0 out_count 1 sideset_base 1 in_base 2
; #pragma pio_sim config set_base 0 set_count 2
; #pragma pio_sim config out_shift left autopull on pull_thresh 8
; #pragma pio_sim config in_shift left autopush on push_thresh 8
;
; Shifting left sends bits 31, 30, ... first, so a byte goes in the top 8
; bits. (A C program writes the byte with an 8-bit store, which puts it
; in every byte of the word.) DMA writes two bytes and reads the replies.
; #pragma pio_sim dma put 0xA5000000 0x3C000000
; #pragma pio_sim dma get
;
; MISO: a device answering 0xC3 (1100 0011), 4 clocks a bit.
; #pragma pio_sim pin 2 hi 8 low 16 hi 8

.program spi_mode0
.side_set 1
    set pindirs, 3      side 0  ; GPIO 0 and 1 as outputs (set_base 0)
.wrap_target
    out pins, 1         side 0 [1]  ; next bit on MOSI, SCK low
    in pins, 1          side 1 [1]  ; SCK high: sample MISO
.wrap`
    },
    i2s: {
        group: 'Protocols', label: 'I2S audio out (16-bit stereo)',
        code: `; I2S output, 16-bit stereo. DATA = GPIO 0, BCLK = GPIO 1,
; LRCLK = GPIO 2 (low: left channel, high: right).
; Each 32-bit FIFO word is one frame: left sample in the top 16 bits,
; right in the bottom 16, MSB first. As I2S requires, LRCLK changes one
; BCLK before a channel's first bit: the last bit of each channel goes
; out with LRCLK already showing the next one.
; The same loop structure as audio_i2s.pio in pico-extras.
;
; 2 cycles per bit, 64 per frame: sample rate = sysclk / (64 * clkdiv).
; #pragma pio_sim config out_base 0 out_count 1 set_base 0 set_count 3 sideset_base 1
; #pragma pio_sim config out_shift left autopull on pull_thresh 32
;
; DMA writes frames (left 0xF0F0, right 0x00FF), then (0x8001, 0x7FFE),
; over and over.
; #pragma pio_sim dma put 0xF0F000FF 0x80017FFE loop

.program i2s_out
.side_set 2                         ; bit 1 = LRCLK, bit 0 = BCLK
    set pindirs, 7      side 0b01   ; GPIO 0-2 as outputs
    set x, 14           side 0b01   ; 15 bits in the loop + 1 after it
.wrap_target
left_bits:
    out pins, 1         side 0b00   ; left bit on DATA, BCLK low
    jmp x-- left_bits   side 0b01   ; BCLK high: the receiver samples
    out pins, 1         side 0b10   ; last left bit; LRCLK goes high
    set x, 14           side 0b11
right_bits:
    out pins, 1         side 0b10   ; right bit
    jmp x-- right_bits  side 0b11
    out pins, 1         side 0b00   ; last right bit; LRCLK goes low
    set x, 14           side 0b01
.wrap`
    },
    ws2812: {
        group: 'Protocols', label: 'WS2812 / NeoPixel LEDs',
        code: `; WS2812(B) LEDs ("NeoPixel") on GPIO 0, one wire.
; Every bit is a 10-cycle high/low pulse: a long high for 1, a short one
; for 0. At 800 kHz that is 8 MHz, clkdiv 150 / 8 = 18.75 on an RP2350
; (125 / 8 = 15.625 on an RP2040).
;   1: high 7 cycles, low 3      0: high 3 cycles, low 7
; Built like ws2812.pio in pico-examples.
;
; Colours are 24 bits in green, red, blue order, sent MSB first; a word
; holds one LED in its top 24 bits (0xGGRRBB00). When the FIFO runs dry,
; OUT stalls with the line low, which latches the colours.
; #pragma pio_sim config sideset_base 0 set_base 0 set_count 1 clkdiv 18.75
; #pragma pio_sim config out_shift left autopull on pull_thresh 24
; DMA writes LED 0 red, LED 1 green, LED 2 blue (half brightness):
; #pragma pio_sim dma put 0x00FF0000 0xFF000000 0x00008000

.program ws2812
.side_set 1
.define T1 3                        ; high, every bit
.define T2 4                        ; high for a 1, low for a 0
.define T3 3                        ; low, every bit
    set pindirs, 1      side 0      ; GPIO 0 as an output
.wrap_target
bitloop:
    out x, 1            side 0 [T3 - 1] ; next bit; the line low
    jmp !x do_zero      side 1 [T1 - 1] ; line high
do_one:
    jmp bitloop         side 1 [T2 - 1] ; a 1: stay high
do_zero:
    nop                 side 0 [T2 - 1] ; a 0: go low
.wrap`
    },
    irq_handshake: {
        group: 'IRQ and several state machines', label: 'IRQ handshake (#pragma pio_sim irq)',
        code: `; One side of a handshake between two state machines, the other side
; played by IRQ pragmas. Use this to test a program on its own before
; its partner exists.
;   irq set|clear <n> [delay <clocks>] [repeat <clocks>] [count <n>]
;
; The partner takes IRQ 0, as its 'wait 1 irq 0' would (clearing it):
; #pragma pio_sim irq clear 0 delay 4 repeat 8
; and hands back with IRQ 1, as its 'irq set 1' would:
; #pragma pio_sim irq set 1 delay 7 repeat 8
;
; #pragma pio_sim config set_base 0 set_count 1

.program ping
    set pindirs, 1  ; GPIO 0 as an output
.wrap_target
    set pins, 1     ; this side's work: a pulse on GPIO 0
    set pins, 0
    irq set 0       ; wake the partner
    wait 1 irq 1    ; stall until the partner sets IRQ 1, then clear it
.wrap

; The 'Ping-pong' example runs both sides.`
    },
    pingpong: {
        group: 'IRQ and several state machines', label: 'Ping-pong (2 state machines)',
        code: `; Two state machines take turns, handing over with IRQ flags.
; Programs go to SM0, SM1, ... in source order, unless
; '; #pragma pio_sim sm <n> program <name>' says otherwise.
; Click SM0 / SM1 in the State panel to see each one.

.program ping
; This program's settings (SM0):
; #pragma pio_sim config set_base 0 set_count 1
    set pindirs, 1     ; GPIO 0 as an output
.wrap_target
    set pins, 1        ; SM0's work: a pulse on GPIO 0
    set pins, 0
    irq set 0          ; wake SM1
    wait 1 irq 1       ; stall until SM1 sets IRQ 1 (and clear it)
.wrap

.program pong
; #pragma pio_sim config set_base 1 set_count 1
    set pindirs, 1     ; GPIO 1 as an output
.wrap_target
    wait 1 irq 0       ; stall until SM0 sets IRQ 0 (and clear it)
    set pins, 1        ; SM1's work: a pulse on GPIO 1
    set pins, 0
    irq set 1          ; hand back to SM0
.wrap`
    },
    shared_program: {
        group: 'IRQ and several state machines', label: 'One program on 3 state machines (irq rel)',
        code: `; One program run by three state machines, each passing a token to the
; next. 'irq ... rel' adds the state machine number to the flag (within
; flags 4-7 here), so the same code talks to a different neighbour on
; each, and 'config sm <n>' gives each copy its own pin.
;
; #pragma pio_sim sm 0 program relay
; #pragma pio_sim sm 1 program relay
; #pragma pio_sim sm 2 program relay
; #pragma pio_sim config sm 0 set_base 0
; #pragma pio_sim config sm 1 set_base 1
; #pragma pio_sim config sm 2 set_base 2
; Start the chain: SM0 waits on IRQ 4, so set it at clock 2.
; #pragma pio_sim irq set 4 delay 2

.program relay
; #pragma pio_sim config set_count 1
    set pindirs, 1     ; this state machine's pin as an output
.wrap_target
    wait 1 irq 4 rel   ; SM n waits on flag 4 + n
    set pins, 1 [3]    ; its pulse
    set pins, 0
    irq set 5 rel      ; wakes SM n + 1 (flag 4 + n + 1)
.wrap

; SM2 sets flag 7, which no state machine waits on, so the token goes
; round once. Click IRQ 4 in the Interrupts panel to send another.`
    }
};

// The example menu, grouped.
{
    const groups = new Map();
    for (const [key, ex] of Object.entries(examples)) {
        if (!groups.has(ex.group)) {
            const g = document.createElement('optgroup');
            g.label = ex.group;
            groups.set(ex.group, g);
            exampleSelect.appendChild(g);
        }
        const o = document.createElement('option');
        o.value = key;
        o.textContent = ex.label;
        groups.get(ex.group).appendChild(o);
    }
}

exampleSelect.addEventListener('change', () => {
    const key = exampleSelect.value;
    if (examples[key]) {
        const ex = examples[key];
        codeView.value = ex.code;

        // Every state machine's settings go back to reset values, so nothing
        // is left over from the previous source; the example's own come from
        // its pragmas on Assemble.
        settingsFromDirectives = [new Set(), new Set(), new Set(), new Set()];
        // A new example's flags show by default again.
        timingIrqOverride.clear();
        for (const sm of emulator.sms) {
            Object.assign(sm, PIO_SM_CONFIG_DEFAULTS);
            sm.setFifoMode('txrx');
        }
        selectSm(0, false);

        updateConfig();
    }
});

// Read a numeric setting, clamped to the range of its hardware field.
function readSetting(input, lo, hi, fallback) {
    let v = parseInt(input.value);
    if (isNaN(v)) v = fallback;
    v = Math.min(hi, Math.max(lo, v));
    if (String(v) !== input.value) input.value = v;
    return v;
}

// The controls show the selected state machine's settings.
function updateConfig() {
    const sm = cur();
    sm.outBase = readSetting(cfgOutBase, 0, 31, 0);
    sm.outCount = readSetting(cfgOutCount, 0, 32, 0);
    sm.setBase = readSetting(cfgSetBase, 0, 31, 0);
    sm.setCount = readSetting(cfgSetCount, 0, 5, 5);
    sm.sidesetBase = readSetting(cfgSidesetBase, 0, 31, 0);
    sm.inBase = readSetting(cfgInBase, 0, 31, 0);
    sm.inCount = readSetting(cfgInCount, 1, 32, 32);
    sm.jmpPin = readSetting(cfgJmpPin, 0, 31, 0);
    sm.setFifoMode(cfgFifoMode.value);
    sm.clkDiv = readClkDiv();
    sm.inShiftDir = cfgInShiftDir.value;
    sm.outShiftDir = cfgOutShiftDir.value;
    sm.autoPush = cfgAutoPush.checked;
    sm.pushThresh = parseInt(cfgPushThresh.value);
    sm.autoPull = cfgAutoPull.checked;
    sm.pullThresh = parseInt(cfgPullThresh.value);
    sm.statusSel = parseInt(cfgStatusSel.value);
    sm.statusN = readSetting(cfgStatusN, 0, 31, 0);
    updateOutCountHint();
}

// Show a state machine's settings in the controls.
function loadControls() {
    const sm = cur();
    cfgOutBase.value = sm.outBase;
    cfgOutCount.value = sm.outCount;
    cfgSetBase.value = sm.setBase;
    cfgSetCount.value = sm.setCount;
    cfgSidesetBase.value = sm.sidesetBase;
    cfgInBase.value = sm.inBase;
    cfgInCount.value = sm.inCount;
    cfgJmpPin.value = sm.jmpPin;
    cfgFifoMode.value = sm.fifoMode;
    cfgClkDiv.value = sm.clkDiv;
    cfgInShiftDir.value = sm.inShiftDir;
    cfgOutShiftDir.value = sm.outShiftDir;
    cfgAutoPush.checked = sm.autoPush;
    cfgPushThresh.value = sm.pushThresh;
    cfgAutoPull.checked = sm.autoPull;
    cfgPullThresh.value = sm.pullThresh;
    cfgStatusSel.value = sm.statusSel;
    cfgStatusN.value = sm.statusN;
    updateOutCountHint();
}

function selectSm(i, refresh = true) {
    sel = i;
    loadControls();
    lastTxMessage = 'Nothing put yet';
    lastRxMessage = 'Not read yet';
    if (refresh) {
        updateUI();
        // Choosing a state machine means wanting to see its PC.
        codeView.resumeFollow();
    }
}

// Several state machines are in play: show the summary and the tabs.
function multiSm() {
    return emulator.enabledSms().length > 1 || sel !== 0 || (lastProgram && lastProgram.programs.length > 1);
}

// OUT_COUNT resets to 0 on hardware, which makes OUT/MOV to pins do nothing.
// Point that out when the selected state machine's program relies on it.
function updateOutCountHint() {
    const sm = cur();
    const p = sm.program;
    let usesOutPins = false;
    if (sm.enabled && p) {
        for (let a = p.offset; a < p.offset + (p.length || emulator.instructions.length); a++) {
            const instr = emulator.instructions[a];
            if (instr && (instr.type === 'OUT' || instr.type === 'MOV') &&
                (instr.dest === 'pins' || instr.dest === 'pindirs')) usesOutPins = true;
        }
    }
    cfgOutCountHint.style.display = (usesOutPins && sm.outCount === 0) ? '' : 'none';
}

function onConfigChange() {
    updateConfig();
    updateUI();
}

cfgOutCount.addEventListener('change', onConfigChange);
cfgInCount.addEventListener('change', onConfigChange);
cfgFifoMode.addEventListener('change', onConfigChange);
cfgClkDiv.addEventListener('change', onConfigChange);

// CLKDIV is 16.8 fixed point; INT 0 would mean 65536, which is not offered.
function readClkDiv() {
    let v = parseFloat(cfgClkDiv.value);
    if (isNaN(v)) v = 1;
    v = Math.min(65535, Math.max(1, Math.floor(v * 256) / 256));
    if (String(v) !== cfgClkDiv.value) cfgClkDiv.value = v;
    return v;
}

// With a divider, say what it does to input latency in state machine cycles.
function updateClkDivNote() {
    const sm = cur();
    if (sm.clkDiv === 1) {
        cfgClkDivNote.style.display = 'none';
        latencyNote.textContent = '';
        return;
    }
    const l = sm.inputLatency();
    const frac = sm.clkDiv !== Math.floor(sm.clkDiv);
    const who = multiSm() ? `SM${sel}, ` : '';
    const text = `With ${who}clock div ${sm.clkDiv}: an input change is seen ${l.external.bypassed} / ${l.external.synced} ` +
        `cycles later (bypassed / synchronized), the program's own output ${l.own.bypassed} / ${l.own.synced} cycles later` +
        ` (JMP PIN: ${l.jmpOwn.bypassed} / ${l.jmpOwn.synced})` +
        (frac ? ' (± 1 with a fractional divider)' : '') + '.';
    cfgClkDivNote.textContent = text;
    cfgClkDivNote.style.display = '';
    latencyNote.textContent = text;
}
cfgOutBase.addEventListener('change', updateConfig);
cfgSetBase.addEventListener('change', updateConfig);
cfgSetCount.addEventListener('change', updateConfig);
cfgSidesetBase.addEventListener('change', updateConfig);
cfgInBase.addEventListener('change', updateConfig);
cfgJmpPin.addEventListener('change', updateConfig);
cfgInShiftDir.addEventListener('change', updateConfig);
cfgOutShiftDir.addEventListener('change', updateConfig);
cfgAutoPush.addEventListener('change', updateConfig);
cfgPushThresh.addEventListener('change', updateConfig);
cfgAutoPull.addEventListener('change', updateConfig);
cfgPullThresh.addEventListener('change', updateConfig);
cfgStatusSel.addEventListener('change', updateConfig);
cfgStatusN.addEventListener('change', updateConfig);

function parseUserNumber(input) {
    const raw = input.trim().toLowerCase();
    if (raw === '') return NaN;
    if (raw.startsWith('0x')) return parseInt(raw.substring(2), 16);
    if (raw.startsWith('0b')) return parseInt(raw.substring(2), 2);
    if (/^[0-9]+$/.test(raw)) return parseInt(raw, 10);
    if (/^[0-9a-f]+$/.test(raw)) return parseInt(raw, 16);
    return NaN;
}

btnPutTx.addEventListener('click', () => {
    const val = parseUserNumber(txInput.value);
    if (!isNaN(val)) {
        if (cur().pushTx(val)) {
            const hex = '0x' + (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
            lastTxMessage = `Put ${hex}`;
            updateUI();
            txInput.value = '';
        } else {
            lastTxMessage = cur().txCapacity() === 0
                ? 'TX FIFO is unavailable in this FIFO mode'
                : 'TX FIFO is full';
            updateUI();
        }
    } else {
        lastTxMessage = 'Enter a valid number';
        updateUI();
    }
});

txInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        btnPutTx.click();
    }
});

btnGetRx.addEventListener('click', () => {
    const val = cur().pullRx();
    if (val === null) {
        lastRxMessage = 'RX FIFO is empty';
        updateUI();
        return;
    }

    const hex = '0x' + (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
    lastRxMessage = `Got ${hex}`;
    updateUI();
});

// In the "get" FIFO mode the system writes the RX FIFO storage registers
// (RXFx_PUTGETn) and the state machine reads them.
btnWriteRxReg.addEventListener('click', () => {
    const val = parseUserNumber(rxRegInput.value);
    if (isNaN(val)) return;
    cur().rxRegs[parseInt(rxRegIndex.value)] = val >>> 0;
    rxRegInput.value = '';
    updateUI();
});

rxRegInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        btnWriteRxReg.click();
    }
});

function assembleAndReset() {
    try {
        const source = codeEditor.value;
        const program = assembler.assemble(source);
        emulator.loadProgram(program);
        lastProgram = program;
        if (!emulator.sms[sel].enabled) sel = emulator.sms.findIndex(sm => sm.enabled) >= 0 ? emulator.sms.findIndex(sm => sm.enabled) : 0;

        addrText = new Map();
        for (const p of program.programs) {
            for (const m of p.programMap) addrText.set(m.pc, m.text.split(';')[0].split('//')[0].trim());
        }
        // Addresses in the gutter; breakpoints stay on their source lines.
        codeView.setAssembly(program);
        if (program.chip) {
            cfgChip.value = program.chip;
            emulator.chip = program.chip;
        }
        // INPUT_SYNC_BYPASS from the source; without the pragma the GPIO
        // panel keeps what it shows.
        if (program.inputSyncBypass !== null && program.inputSyncBypass !== undefined) {
            emulator.inputSyncBypass = program.inputSyncBypass >>> 0;
        }
        showWarnings(program);
        codeView.setWarnings(program.warnings.map(w => w.line));

        applyProgramConfig(program);
        loadControls();

        errorMessage.textContent = '';
        updateUI();
        console.log("Assembled:", program);
    } catch (e) {
        errorMessage.textContent = e.message;
        warningMessage.textContent = '';
        console.error(e);
        const m = /^Line (\d+):/.exec(e.message);
        codeView.setError(m ? parseInt(m[1]) : null);
    }
}

// Settings named in the source — by directives (.in, .out, .set, .fifo,
// .mov_status, .clock_div) or by `; #pragma pio_sim config` — are applied
// to each state machine on assemble. Other settings are left alone. A
// setting that the source set last time goes back to its hardware reset
// value once the line is gone, so a deleted `.fifo tx` does not linger.
const DIRECTIVE_SETTINGS = Object.assign({}, PIO_SM_CONFIG_DEFAULTS, { fifoMode: 'txrx' });
let settingsFromDirectives = [new Set(), new Set(), new Set(), new Set()];

function applyProgramConfig(program) {
    emulator.sms.forEach((sm, i) => {
        const config = program.smConfigs[i] || {};
        const now = new Set();
        for (const key of Object.keys(DIRECTIVE_SETTINGS)) {
            let value;
            if (config[key] !== undefined) {
                value = config[key];
                now.add(key);
            } else if (settingsFromDirectives[i].has(key)) {
                value = DIRECTIVE_SETTINGS[key];
            } else {
                continue;
            }
            if (key === 'fifoMode') sm.setFifoMode(value);
            else sm[key] = value;
        }
        settingsFromDirectives[i] = now;
    });
}

// A breakpoint stops the run when any state machine is about to execute
// the instruction there (not while the one before it is still in its delay,
// with PC already pointing at it).
function atBreakpoint() {
    return emulator.enabledSms().some(sm => sm.delay === 0 && breakpoints.has(sm.pc));
}

// A state machine's state for its badge: running, stalled, ... and while an
// instruction's delay runs, which delay cycle the next step is.
function smBadge(sm) {
    if (!sm.enabled) return { cls: 'off', text: 'OFF', title: '' };
    if (emulator.error && sm.status === 'error') return { cls: 'error', text: 'ERROR', title: '' };
    if (sm.status === 'running' && sm.delay > 0) {
        const k = sm.delayTotal - sm.delay + 1;
        const of = sm.delayPc !== null ? `address ${sm.delayPc}` : 'an EXEC\'d instruction';
        return {
            cls: 'delay', text: `DELAY ${k}/${sm.delayTotal}`,
            title: `The next step is delay cycle ${k} of ${sm.delayTotal} of ${of}. PC already shows the next instruction, as SMx_ADDR does on the chip.`
        };
    }
    return { cls: sm.status, text: sm.status.toUpperCase(), title: '' };
}

function toggleRunStop() {
    if (runInterval) {
        stop();
    } else {
        run();
    }
}

function run() {
    if (runInterval) return;
    btnRunStop.textContent = 'Stop';

    const speedSel = document.getElementById('run-speed');
    const period = speedSel ? parseInt(speedSel.value) : 100;

    if (period === 0) {
        // "Max" mode: as many steps as fit in a slice of each frame. Not a
        // fixed count: a count that is a multiple of the program's period
        // (200 steps vs blink's 8) shows the very same state every frame,
        // so the screen looks frozen while the clock runs.
        const FRAME_BUDGET_MS = 8;
        // And never more than this many, should the clock not move (a
        // paused or virtual clock would otherwise never end the frame).
        const FRAME_MAX_STEPS = 100000;
        runMode = 'raf';
        const loop = () => {
            if (runMode !== 'raf') return;
            const until = performance.now() + FRAME_BUDGET_MS;
            // The clock is read every 16 steps, from a random phase, so the
            // count per frame is no multiple of anything in particular.
            const phase = Math.floor(Math.random() * 16);
            for (let i = 0; ; i++) {
                emulator.step();
                if (emulator.error) break;
                if (atBreakpoint()) {
                    updateUI();
                    stop();
                    return;
                }
                if (((i + phase) & 15) === 15 && (performance.now() >= until || i >= FRAME_MAX_STEPS)) break;
            }
            updateUI();
            if (emulator.error) {
                stop();
                errorMessage.textContent = emulator.error;
                return;
            }
            runInterval = requestAnimationFrame(loop);
        };
        runInterval = requestAnimationFrame(loop);
    } else {
        runMode = 'interval';
        runInterval = setInterval(() => {
            emulator.step();
            updateUI();
            if (emulator.error) {
                stop();
                errorMessage.textContent = emulator.error;
                return;
            }
            if (atBreakpoint()) {
                stop();
            }
        }, period);
    }
}

function stop() {
    if (runInterval) {
        if (runMode === 'raf') {
            cancelAnimationFrame(runInterval);
        } else {
            clearInterval(runInterval);
        }
        runInterval = null;
        runMode = null;
        btnRunStop.textContent = 'Run';
        updateUI();
    }
}

function step() {
    stop();
    emulator.step();
    if (emulator.error) errorMessage.textContent = emulator.error;
    updateUI(true);
}

function reset() {
    stop();
    emulator.reset();
    updateConfig();
    updateUI();
}

const hex8 = v => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

// Short text of the instruction a state machine is at.
function instrText(addr) {
    if (addrText.has(addr)) return addrText.get(addr);
    return emulator.instructions[addr] ? '' : '(empty: jmp 0)';
}

// The summary rows and the tab buttons are made once and only updated
// afterwards. Rebuilding them on every screen update (each step while
// running) would replace a button between press and release, and the click
// would be lost.
const smRows = emulator.sms.map((sm, i) => {
    const tr = document.createElement('tr');
    const cells = [];
    for (let k = 0; k < 8; k++) {
        const td = document.createElement('td');
        tr.appendChild(td);
        cells.push(td);
    }
    cells[0].textContent = `SM${i}`;
    cells[4].className = 'instr';
    const status = document.createElement('span');
    cells[2].appendChild(status);
    tr.addEventListener('click', () => selectSm(i));
    smSummaryBody.appendChild(tr);
    return { tr, cells, status };
});
const smTabs = smTabContainers.map(box => emulator.sms.map((sm, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sm-tab';
    b.textContent = `SM${i}`;
    b.addEventListener('click', () => selectSm(i));
    box.appendChild(b);
    return b;
}));

// Set text only when it changed, so an update does not disturb the page.
function setText(el, text) {
    text = String(text);
    if (el.textContent !== text) el.textContent = text;
}

const SM_COLORS = ['#1e88e5', '#43a047', '#fb8c00', '#8e24aa'];
const SM_TINTS = ['rgba(30, 136, 229, 0.05)', 'rgba(67, 160, 71, 0.05)', 'rgba(251, 140, 0, 0.06)', 'rgba(142, 36, 170, 0.05)'];

function updateSmPanels() {
    const multi = multiSm();
    document.body.classList.toggle('multi-sm', multi);
    document.body.style.setProperty('--sm-color', SM_COLORS[sel]);
    document.body.style.setProperty('--sm-tint', SM_TINTS[sel]);
    document.querySelectorAll('.multi-sm-only').forEach(el => { el.style.display = multi ? '' : 'none'; });
    document.querySelectorAll('.sm-suffix').forEach(el => setText(el, multi ? ` (SM${sel})` : ''));
    if (!multi) return;

    emulator.sms.forEach((sm, i) => {
        const row = smRows[i];
        row.tr.classList.toggle('selected', i === sel);
        row.tr.classList.toggle('off', !sm.enabled);
        const badge = smBadge(sm);
        // The instruction the next step belongs to (in a delay, the one
        // whose delay it is), as the editor highlights it; PC is the chip's.
        const values = sm.enabled
            ? [`SM${i}`, sm.program ? sm.program.name : '', null, sm.pc, instrText(sm.activeAddr()), hex8(sm.x), hex8(sm.y), sm.cycles]
            : [`SM${i}`, '', null, '', '', '', '', ''];
        values.forEach((v, k) => { if (k !== 2) setText(row.cells[k], v); });
        row.cells[1].title = values[1];
        row.cells[4].title = values[4];
        row.status.className = `sm-status ${badge.cls}`;
        row.status.title = badge.title;
        setText(row.status, badge.text);

        for (const tabs of smTabs) {
            const b = tabs[i];
            b.classList.toggle('selected', i === sel);
            b.classList.toggle('off', !sm.enabled);
            b.title = sm.enabled ? `SM${i}: ${sm.program ? sm.program.name : ''}` : `SM${i}: not running`;
        }
    });
}

function updateUI(isStep = false) {
    const sm = cur();
    updateSmPanels();

    // The heading shows the simulator's run state, the same whichever state
    // machine is selected. Each state machine's own state (running,
    // stalled) is in its PC box and in the summary.
    let displayStatus = emulator.error ? 'ERROR' : (runInterval ? 'RUNNING' : (isStep ? 'STEP' : 'STOPPED'));
    statusIndicator.textContent = displayStatus;

    const badge = smBadge(sm);
    regSmStatus.className = `sm-status ${badge.cls}`;
    regSmStatus.title = badge.title;
    setText(regSmStatus, badge.text);

    if (displayStatus === 'RUNNING') {
        statusIndicator.style.backgroundColor = '#4caf50';
        statusIndicator.style.color = 'white';
    } else if (displayStatus === 'ERROR') {
        statusIndicator.style.backgroundColor = '#f44336';
        statusIndicator.style.color = 'white';
    } else if (displayStatus === 'STEP') {
        statusIndicator.style.backgroundColor = '#2196f3';
        statusIndicator.style.color = 'white';
    } else {
        statusIndicator.style.backgroundColor = '#9e9e9e';
        statusIndicator.style.color = 'white';
    }

    regPc.textContent = sm.pc;
    regCycles.textContent = sm.cycles;
    regClock.textContent = emulator.clock;
    const anyDivider = emulator.enabledSms().some(s => s.clkDiv !== 1);
    regSysclk.textContent = anyDivider ? ` (system clock ${emulator.sysclk})` : '';
    updateClkDivNote();
    regX.textContent = hex8(sm.x);
    regY.textContent = hex8(sm.y);
    regOsr.textContent = hex8(sm.osr);
    regOsrCount.textContent = sm.osrCount;
    regIsr.textContent = hex8(sm.isr);
    regIsrCount.textContent = sm.isrCount;

    // FIFOs, each from end to end: the system side (Put / Get, or DMA) and
    // the state machine side (pull / push, autopull / autopush).
    setFifoSlots(txFifoList, sm.txFifo, sm.txCapacity());
    setText(txSmSide, sm.txCapacity() === 0 ? 'none: joined into the RX FIFO (.fifo rx)'
        : sm.autoPull ? `pull, autopull at ${sm.pullThresh} bits \u2192 OSR` : 'pull \u2192 OSR (autopull off)');
    const dma = sm.dma;
    txDmaNote.style.display = dma.put.length ? '' : 'none';
    if (dma.put.length) {
        const sent = dma.loop ? sm.dmaPos : Math.min(sm.dmaPos, dma.put.length);
        setText(txDmaNote, `DMA put: ${sent} of ${dma.put.length} words written` +
            (dma.loop ? ' (loops)' : sent === dma.put.length ? ' (all written)' : ''));
    }

    // In the put/get FIFO modes the RX FIFO storage is four registers.
    const fifoMode = sm.fifoMode;
    const rxAsRegs = fifoMode === 'txput' || fifoMode === 'txget' || fifoMode === 'putget';
    rxFifoTitle.textContent = rxAsRegs ? 'RX FIFO registers' : 'RX FIFO';
    rxSmEnd.style.display = rxAsRegs ? 'none' : '';
    setText(rxSmSide, sm.rxCapacity() === 0 ? 'none: joined into the TX FIFO (.fifo tx)'
        : sm.autoPush ? `ISR \u2192 push, autopush at ${sm.pushThresh} bits` : 'ISR \u2192 push (autopush off)');
    // With DMA reading the RX FIFO, Get would find it empty: DMA's reads
    // take its place.
    rxGetControls.style.display = rxAsRegs || dma.get ? 'none' : 'flex';
    rxRegControls.style.display = fifoMode === 'txget' ? 'flex' : 'none';
    rxRegNote.style.display = rxAsRegs ? '' : 'none';
    if (rxAsRegs) {
        rxRegNote.textContent = {
            txput: 'Written by the program (mov rxfifo[n], isr), readable by the system.',
            txget: 'Written by the system, read by the program (mov osr, rxfifo[n]).',
            putget: 'Read and written by the program only.'
        }[fifoMode];
        rxFifoList.innerHTML = sm.rxRegs
            .map((v, i) => `<li>[${i}] 0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}</li>`).join('');
    } else {
        setFifoSlots(rxFifoList, sm.rxFifo, sm.rxCapacity());
    }
    rxDmaNote.style.display = dma.get && !rxAsRegs ? '' : 'none';
    if (dma.get) {
        const last = sm.dmaRead.slice(-8);
        setText(rxDmaNote, `DMA get has read ${sm.dmaRead.length}${sm.dmaRead.length >= 256 ? '+' : ''} words, latest last: ` +
            (last.length ? last.map(fifoWordText).join(' ') : 'none yet'));
    }
    setText(txPutResult, lastTxMessage);
    setText(rxGetResult, lastRxMessage);

    const allPins = emulator.getAllPinStates();
    gpioHexVal.textContent = '0x' + (allPins >>> 0).toString(16).toUpperCase().padStart(8, '0');

    const bypassMask = emulator.inputSyncBypass >>> 0;
    const ff1 = emulator.inputsFf1 >>> 0;
    const ff2 = emulator.inputsFf2 >>> 0;
    gpioFf1HexVal.textContent = '0x' + ff1.toString(16).toUpperCase().padStart(8, '0');
    gpioFf2HexVal.textContent = '0x' + ff2.toString(16).toUpperCase().padStart(8, '0');
    const seen = emulator.inputsSeen >>> 0;
    gpioSeenHexVal.textContent = '0x' + seen.toString(16).toUpperCase().padStart(8, '0');
    // FF stages are dead weight when every pin bypasses the synchronizer.
    const ffVisible = bypassMask !== 0xFFFFFFFF ? '' : 'none';
    gpioFf1Row.style.display = ffVisible;
    gpioFf2Row.style.display = ffVisible;

    const stimMask = emulator.stimulusMask();

    for (let i = 0; i < 32; i++) {
        const bit = document.getElementById(`gpio-bit-${i}`);
        const isOut = (emulator.pindirs >> i) & 1;
        const val = (allPins >> i) & 1;
        const bypass = (bypassMask >> i) & 1;
        const stim = (stimMask >> i) & 1;

        bit.className = 'gpio-bit';
        if (!isOut) bit.classList.add('input');
        if (val) bit.classList.add('on');
        // Mark inputs whose synchronizer is engaged (hardware default).
        if (!isOut && !bypass) bit.classList.add('synced');
        // Mark pins driven by a `#pragma pio_sim` waveform.
        if (stim) bit.classList.add('stim');

        // Outputs are read back through the same input path as inputs.
        const seenBit = (seen >> i) & 1;
        const syncNote = ` [PIO sees ${seenBit}; SYNC ${bypass ? 'BYPASSED' : 'ENGAGED'}]`;
        const stimNote = stim
            ? (isOut ? ' [STIMULUS — ignored while Output]' : ' [STIMULUS]')
            : '';
        bit.title = `GPIO ${i}: ${isOut ? 'Output' : 'Input'} = ${val}${syncNote}${stimNote}`;
    }

    const irqEventMask = emulator.irqEventMask();
    for (let i = 0; i < 8; i++) {
        const flag = document.getElementById(`irq-flag-${i}`);
        if ((emulator.irq >> i) & 1) {
            flag.classList.add('active');
        } else {
            flag.classList.remove('active');
        }
        // Mark flags scheduled by a `#pragma pio_sim irq` line.
        const scheduled = (irqEventMask >> i) & 1;
        flag.classList.toggle('scheduled', scheduled === 1);
        flag.title = scheduled ? `IRQ ${i}: set/cleared by #pragma pio_sim irq` : `IRQ ${i}`;
    }

    // The selected state machine's line is highlighted in the editor, and
    // every running one is marked in the gutter when there are several.
    // The line each state machine's next step belongs to: in a delay, the
    // instruction whose delay it is (each line is lit 1 + delay steps).
    codeView.setPcs(emulator.enabledSms().map(s => ({
        sm: s.index, pc: s.activeAddr(),
        delay: s.delay > 0 && s.delayPc !== null ? { k: s.delayTotal - s.delay + 1, n: s.delayTotal } : null
    })), sel, true);

    drawTimingChart();
}

function drawTimingChart() {
    const history = emulator.history;

    let pinsToShow = [];

    if (selectedTimingPins.size > 0) {
        pinsToShow = Array.from(selectedTimingPins);
    } else {
        // Every running state machine's side-set, OUT and SET pins (the
        // first four of each group), and the stimulated pins.
        for (const s of emulator.enabledSms()) {
            for (let i = 0; i < s.sidesetCount; i++) pinsToShow.push((s.sidesetBase + i) & 31);
            for (let i = 0; i < 4; i++) pinsToShow.push((s.outBase + i) & 31);
            for (let i = 0; i < Math.min(s.setCount, 4); i++) pinsToShow.push((s.setBase + i) & 31);
        }
        for (const stim of emulator.stimuli) {
            pinsToShow.push(stim.pin);
        }
    }

    // Stimulus pins are plotted from the driven input waveform, not the
    // output latch.
    const stimMask = emulator.stimulusMask();
    const isStimPin = pin => ((stimMask >> pin) & 1) === 1;

    pinsToShow.sort((a, b) => a - b);
    pinsToShow = [...new Set(pinsToShow)];

    // One-bit rows: the GPIOs, then any IRQ flag scheduled by a pragma.
    const bitRows = pinsToShow.map(pin => ({
        label: `GPIO ${pin}${isStimPin(pin) ? ' (stim)' : ''}`,
        key: isStimPin(pin) ? 'inputs' : 'pins',
        bit: pin,
        color: isStimPin(pin) ? '#ef6c00' : '#007acc'
    }));
    // IRQ flags scheduled by a pragma or used by the running programs.
    let irqMask = emulator.irqEventMask();
    for (const s of emulator.enabledSms()) {
        const p = s.program;
        if (!p) continue;
        for (let a = p.offset; a < p.offset + (p.length || 32); a++) {
            const instr = emulator.instructions[a];
            if (!instr || instr.prev || instr.next) continue;
            if (instr.type === 'IRQ' || (instr.type === 'WAIT' && instr.source === 'irq')) {
                let index = instr.index & 7;
                if (instr.rel) index = (index & 4) | ((index + s.index) & 3);
                irqMask |= 1 << index;
            }
        }
    }
    // A click on a flag's button wins over the default.
    for (const [i, shown] of timingIrqOverride) {
        if (shown) irqMask |= 1 << i;
        else irqMask &= ~(1 << i);
    }
    timingIrqButtons.forEach((btn, i) => btn.classList.toggle('selected', ((irqMask >> i) & 1) === 1));
    const irqsToShow = [];
    for (let i = 0; i < 8; i++) {
        if ((irqMask >> i) & 1) {
            irqsToShow.push(i);
            bitRows.push({ label: `IRQ ${i}`, key: 'irq', bit: i, color: '#7b1fa2' });
        }
    }

    // Register rows, one per running state machine when there are several.
    const running = emulator.enabledSms();
    const regsToShow = [];
    for (const r of TIMING_REGS.filter(r => selectedTimingRegs.has(r.key))) {
        for (const s of running) {
            regsToShow.push({
                label: running.length > 1 ? `SM${s.index} ${r.label}` : r.label,
                format: r.format,
                get: h => (h.sms && h.sms[s.index]) ? h.sms[s.index][r.key] : undefined
            });
        }
    }

    if (pinsToShow.length > 0) {
        const min = pinsToShow[0];
        const max = pinsToShow[pinsToShow.length - 1];
        let titleStr;
        if (pinsToShow.length === (max - min + 1)) {
            titleStr = `GPIO ${min}-${max}`;
        } else {
            titleStr = `GPIO ${pinsToShow.join(',')}`;
        }
        if (irqsToShow.length > 0) {
            titleStr += ` + IRQ ${irqsToShow.join(',')}`;
        }
        if (regsToShow.length > 0) {
            titleStr += ` + ${regsToShow.map(r => r.label).join(', ')}`;
        }
        timingChartTitle.textContent = `Timing Chart (${titleStr})`;
    } else if (regsToShow.length > 0) {
        timingChartTitle.textContent = `Timing Chart (${regsToShow.map(r => r.label).join(', ')})`;
    }

    const numPins = bitRows.length;
    const numRegs = regsToShow.length;
    const totalRows = numPins + numRegs;

    const PIN_ROW_HEIGHT = 30;
    const REG_ROW_HEIGHT = 28;
    const desiredHeight = Math.max(200, numPins * PIN_ROW_HEIGHT + numRegs * REG_ROW_HEIGHT);
    if (canvas.height !== desiredHeight) {
        canvas.height = desiredHeight;
    }
    // One canvas pixel per CSS pixel, so long spans keep their detail.
    const shownWidth = Math.round(canvas.clientWidth);
    if (shownWidth > 0 && canvas.width !== shownWidth) {
        canvas.width = shownWidth;
    }

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    if (history.length === 0 || totalRows === 0) return;

    const maxCycles = parseInt(timingSpan.value) || 50;
    const startIndex = Math.max(0, history.length - maxCycles);
    const visibleHistory = history.slice(startIndex);

    // Row labels get their own gutter on the left, so they never cover the
    // first clocks of a waveform. Everything below is drawn in plot
    // coordinates: x = 0 is the left edge of the plot area.
    const LABEL_W = 104;
    const plotW = width - LABEL_W;
    const stepX = plotW / maxCycles;
    ctx.save();
    ctx.translate(LABEL_W, 0);

    const pinAreaHeight = numPins > 0 ? (height * numPins) / totalRows : 0;
    const regAreaHeight = height - pinAreaHeight;
    const pinRowHeight = numPins > 0 ? pinAreaHeight / numPins : 0;
    const regRowHeight = numRegs > 0 ? regAreaHeight / numRegs : 0;

    // Grid: a line per clock and a darker one every 5, thinned out when
    // the clocks get too narrow to tell apart.
    ctx.lineWidth = 1;
    const major = [5, 10, 50, 100].find(n => n * stepX >= 20) || 100;
    const minor = stepX >= 4 ? 1 : major / 5;
    for (let t = 0; t <= maxCycles; t++) {
        const x = t * stepX;
        // Clock numbers, not array positions: old history is dropped.
        const absClock = (visibleHistory.length ? visibleHistory[0].clock : startIndex) + t;
        if (absClock % minor !== 0) continue;
        ctx.strokeStyle = (absClock % major === 0) ? '#bbb' : '#eee';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.font = '12px Consolas';

    for (let i = 0; i < numPins; i++) {
        const yCenter = i * pinRowHeight + pinRowHeight / 2;
        ctx.beginPath();
        ctx.moveTo(0, yCenter);
        ctx.lineTo(plotW, yCenter);
        ctx.stroke();
    }

    ctx.lineWidth = 2;

    for (let i = 0; i < numPins; i++) {
        const row = bitRows[i];
        const pin = row.bit;
        const yCenter = i * pinRowHeight + pinRowHeight / 2;
        const yOf = v => v ? yCenter - 10 : yCenter + 10;

        if (row.key === 'pins') {
            // A GPIO: its level on the pad, green while PIO drives it (an
            // output) and blue while it is an input. A value written to the
            // output register of a pin that is still an input does not reach
            // the pad; it is drawn dashed.
            const at = h => ({
                driven: ((h.pindirs === undefined ? 0xFFFFFFFF : h.pindirs) >> pin) & 1,
                pad: ((h.pad === undefined ? h.pins : h.pad) >> pin) & 1,
                latch: (h.pins >> pin) & 1
            });
            for (let t = 0; t < visibleHistory.length; t++) {
                const s = at(visibleHistory[t]);
                const x = t * stepX;
                const y = yOf(s.pad);
                ctx.setLineDash([]);
                ctx.lineWidth = 2;
                ctx.strokeStyle = s.driven ? '#2e9e4f' : '#1e88e5';
                ctx.beginPath();
                ctx.moveTo(x, t === 0 ? y : yOf(at(visibleHistory[t - 1]).pad));
                ctx.lineTo(x, y);
                ctx.lineTo(x + stepX, y);
                ctx.stroke();
                if (!s.driven && s.latch !== s.pad) {
                    ctx.setLineDash([3, 3]);
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = '#9e9e9e';
                    ctx.beginPath();
                    ctx.moveTo(x, yOf(s.latch));
                    ctx.lineTo(x + stepX, yOf(s.latch));
                    ctx.stroke();
                }
            }
            ctx.setLineDash([]);
            ctx.lineWidth = 2;
            continue;
        }

        const key = row.key;
        ctx.strokeStyle = row.color;
        ctx.beginPath();
        for (let t = 0; t < visibleHistory.length; t++) {
            const state = (visibleHistory[t][key] >> pin) & 1;
            const x = t * stepX;
            const y = yOf(state);

            if (t === 0) {
                ctx.moveTo(x, y);
            } else {
                const prevState = (visibleHistory[t - 1][key] >> pin) & 1;
                ctx.lineTo(x, yOf(prevState));
                ctx.lineTo(x, y);
            }
            ctx.lineTo(x + stepX, y);
        }
        ctx.stroke();
    }

    ctx.font = '12px Consolas';
    for (let i = 0; i < numPins; i++) {
        const label = bitRows[i].label;
        const yBaseline = i * pinRowHeight + pinRowHeight / 2 + 4;
        ctx.fillStyle = '#000';
        ctx.fillText(label, 5 - LABEL_W, yBaseline);
    }

    for (let i = 0; i < numRegs; i++) {
        const reg = regsToShow[i];
        const yTop = pinAreaHeight + i * regRowHeight + 4;
        const yBot = pinAreaHeight + (i + 1) * regRowHeight - 4;
        const yMid = (yTop + yBot) / 2;

        ctx.font = '12px Consolas';

        ctx.strokeStyle = '#c2185b';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = '#000';

        let segStart = 0;
        for (let t = 1; t <= visibleHistory.length; t++) {
            const ended = (t === visibleHistory.length) ||
                          (reg.get(visibleHistory[t]) !== reg.get(visibleHistory[t - 1]));
            if (!ended) continue;

            const xStart = segStart * stepX;
            const xEnd = t * stepX;

            ctx.beginPath();
            ctx.moveTo(xStart, yTop);
            ctx.lineTo(xEnd, yTop);
            ctx.moveTo(xStart, yBot);
            ctx.lineTo(xEnd, yBot);
            ctx.stroke();

            if (t < visibleHistory.length) {
                ctx.beginPath();
                ctx.moveTo(xEnd, yTop);
                ctx.lineTo(xEnd, yBot);
                ctx.stroke();
            }

            const value = reg.get(visibleHistory[segStart]);
            const text = value === undefined ? '' : reg.format(value);
            const segWidth = xEnd - xStart;
            const segHeight = yBot - yTop;
            const visStart = xStart;
            const visWidth = xEnd - visStart;

            ctx.font = '12px Consolas';
            const twH = ctx.measureText(text).width;
            if (twH + 4 < visWidth) {
                ctx.fillText(text, (visStart + xEnd) / 2 - twH / 2, yMid + 4);
            } else {
                const compact = text.startsWith('0x') ? text.slice(2) : text;
                let placed = false;
                for (let fs = 12; fs >= 8; fs--) {
                    ctx.font = `${fs}px Consolas`;
                    const twV = ctx.measureText(compact).width;
                    if (twV + 2 < segHeight && fs + 1 < segWidth) {
                        ctx.save();
                        ctx.textBaseline = 'middle';
                        ctx.translate((xStart + xEnd) / 2, yMid);
                        ctx.rotate(-Math.PI / 2);
                        ctx.fillText(compact, -twV / 2, 0);
                        ctx.restore();
                        placed = true;
                        break;
                    }
                }
                ctx.font = '12px Consolas';
                if (!placed && segWidth > 8) {
                    let truncated = text;
                    while (truncated.length > 1 && ctx.measureText(truncated + '…').width + 4 >= visWidth) {
                        truncated = truncated.slice(0, -1);
                    }
                    if (truncated.length > 0 && truncated !== text) {
                        const display = truncated + '…';
                        const dw = ctx.measureText(display).width;
                        if (dw + 4 < visWidth) {
                            ctx.fillText(display, (visStart + xEnd) / 2 - dw / 2, yMid + 4);
                        }
                    }
                }
            }

            segStart = t;
        }

        ctx.font = '12px Consolas';
        ctx.fillStyle = '#000';
        ctx.fillText(reg.label, 5 - LABEL_W, yMid + 4);
    }

    // Left edge of the plot area.
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, height);
    ctx.stroke();

    // Cursor under the mouse: a line through one clock, with every row's
    // value at that clock.
    const col = timingCursorX === null ? -1 : Math.floor((timingCursorX - LABEL_W) / stepX);
    if (col >= 0 && col < visibleHistory.length) {
        const h = visibleHistory[col];
        const x = (col + 0.5) * stepX;
        ctx.fillStyle = 'rgba(255, 193, 7, 0.18)';
        ctx.fillRect(col * stepX, 0, stepX, height);
        ctx.strokeStyle = '#e65100';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Values on one side of the line, the clock on the other; flipped
        // near the right edge.
        const flip = x > plotW - 90;
        const box = (text, y, left) => {
            ctx.font = '11px Consolas';
            const w = ctx.measureText(text).width + 6;
            const bx = left ? x - 4 - w : x + 4;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.fillRect(bx, y - 7, w, 14);
            ctx.strokeStyle = '#e65100';
            ctx.strokeRect(bx + 0.5, y - 6.5, w - 1, 13);
            ctx.fillStyle = '#000';
            ctx.fillText(text, bx + 3, y + 4);
        };
        for (let i = 0; i < numPins; i++) {
            const row = bitRows[i];
            const v = row.key === 'pins'
                ? ((h.pad === undefined ? h.pins : h.pad) >> row.bit) & 1
                : (h[row.key] >> row.bit) & 1;
            box(String(v), i * pinRowHeight + pinRowHeight / 2, flip);
        }
        for (let i = 0; i < numRegs; i++) {
            const reg = regsToShow[i];
            const v = reg.get(h);
            box(v === undefined ? '-' : reg.format(v), pinAreaHeight + (i + 0.5) * regRowHeight, flip);
        }
        const clockText = h.sysclk !== undefined && h.sysclk !== h.clock
            ? `clock ${h.clock} (sysclk ${h.sysclk})` : `clock ${h.clock}`;
        box(clockText, 8, !flip);
    }

    ctx.restore();
}

// The timing chart's cursor follows the mouse.
canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    timingCursorX = (e.clientX - rect.left) * canvas.width / rect.width;
    drawTimingChart();
});
canvas.addEventListener('mouseleave', () => {
    timingCursorX = null;
    drawTimingChart();
});

// Restore code from localStorage (if any) before initial assemble.
try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && saved !== '') {
        codeView.value = saved;
    }
} catch (e) {
    // localStorage unavailable (private mode / quota) — silently skip.
}

// Save on every edit.
codeEditor.addEventListener('input', () => {
    try {
        localStorage.setItem(STORAGE_KEY, codeEditor.value);
    } catch (e) {
        // Ignore quota errors.
    }
});

// Loading an example should overwrite persisted code too.
exampleSelect.addEventListener('change', () => {
    try {
        localStorage.setItem(STORAGE_KEY, codeEditor.value);
    } catch (e) {
        // Ignore.
    }
});

assembleAndReset();
