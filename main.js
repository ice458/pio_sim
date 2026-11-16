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
const btnPushTx = document.getElementById('btn-push-tx');
const txPushResult = document.getElementById('tx-push-result');
const txFifoList = document.getElementById('tx-fifo-list');
const rxFifoList = document.getElementById('rx-fifo-list');
const btnPopRx = document.getElementById('btn-pop-rx');
const rxPopResult = document.getElementById('rx-pop-result');

const rxFifoTitle = document.getElementById('rx-fifo-title');
const rxPopControls = document.getElementById('rx-pop-controls');
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
let lastTxMessage = 'Not pushed yet';

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

btnAssemble.addEventListener('click', assembleAndReset);
btnStep.addEventListener('click', step);
btnRunStop.addEventListener('click', toggleRunStop);
btnReset.addEventListener('click', reset);

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

const examples = {
    blink: {
        code: `.program blink

    set pindirs, 1   ; GPIO 0 as an output
.wrap_target
    set pins, 1      ; Turn on
    set pins, 0      ; Turn off
.wrap`,
        config: {
            outBase: 0, setBase: 0, sidesetBase: 0, inBase: 0, jmpPin: 0,
            inShiftDir: 'right', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    },
    pwm: {
        code: `.program pwm
.side_set 1 opt

; Setup: GPIO 0 (side-set) as an output, load Period into ISR
    set pindirs, 1         ; GPIO 0 as an output
    pull block      ; 1. Push Period (e.g. 8) to TX FIFO
    out isr, 32     ; 2. ISR = Period

.wrap_target
    pull noblock    side 0 ; Pull Level (e.g. 0 to 7) from FIFO (if empty, use X)
    mov x, osr             ; X = Level
    mov y, isr             ; Y = Period (Counter)
countloop:
    jmp x!=y noset         ; If Counter == Level, set Pin High
    jmp skip        side 1 ; Side-set 1 (High)
noset:
    nop                    ; Balance delay
skip:
    jmp y-- countloop      ; Loop until Y=0
.wrap`,
        config: {
            outBase: 0, setBase: 0, sidesetBase: 0, inBase: 0, jmpPin: 0,
            inShiftDir: 'right', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    },
    feature_test: {
        code: `.program feature_test
.side_set 1 opt

; Simulator settings, loaded on Assemble (plain comments for pioasm):
; #pragma pio_sim config out_base 0 out_count 2 set_base 0
; #pragma pio_sim config sideset_base 4 in_base 0 jmp_pin 5 in_shift left
; Click GPIO 5 to drive the input.

    set pindirs, 3      side 0 ; Set GPIO 0,1 as Output
    
loop:
    pull block          side 0 ; Wait for TX FIFO
    out pins, 2         side 1 ; Output 2 bits to GPIO 0,1. Side-set GPIO 4 High.
    
    wait 1 pin 5        side 0 ; Wait for GPIO 5 (Input) High. Side-set Low.
    
    in pins, 6          side 1 ; Read GPIO 0-5.
    push noblock        side 0 ; Push to RX FIFO.
    
    irq 0               side 1 ; Trigger IRQ 0.
    
    jmp pin is_high     side 0 ; Jump if GPIO 5 is High (it should be, passed wait)
    jmp loop            side 0

is_high:
    set pins, 0         side 1 ; Turn off GPIO 0,1
    jmp loop            side 0`,
        config: {
            outBase: 0, outCount: 2, setBase: 0, sidesetBase: 4, inBase: 0, jmpPin: 5,
            inShiftDir: 'left', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    },
    stimulus: {
        code: `.program stimulus

; Input waveforms for the simulator (plain comments for pioasm).
; pin <n> [<hi|low> delay <clocks>] <hi|low> <clocks> ... [count <n>]
;
; GPIO 5: low 7 clocks, high 3, repeating forever
; #pragma pio_sim pin 5 low 7 hi 3
; GPIO 4: low for 12 clocks, then 3 pulses
; #pragma pio_sim pin 4 low delay 12 hi 1 low 9 count 3

; Simulator settings, loaded on Assemble:
; #pragma pio_sim config set_base 0 set_count 1 in_base 0

    set pindirs, 1  ; GPIO 0 as an output
.wrap_target
    wait 1 pin 5    ; Wait for GPIO 5 High
    set pins, 1     ; Copy it to GPIO 0
    wait 0 pin 5    ; Wait for GPIO 5 Low
    set pins, 0
.wrap`,
        config: {
            outBase: 0, setBase: 0, sidesetBase: 0, inBase: 0, jmpPin: 0,
            inShiftDir: 'right', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    },
    pingpong: {
        code: `; Two state machines handing control back and forth (issue #3).
; SM0 runs ping_sm0 and SM1 runs pong_sm1: programs go to SM0, SM1, ... in
; source order unless '; #pragma pio_sim sm <n> program <name>' says otherwise.

.program ping_sm0
; #pragma pio_sim config set_base 0 set_count 1
    set pindirs, 1     ; GPIO 0 as an output
.wrap_target
    set pins, 1        ; SM0 work: pulse GPIO 0
    set pins, 0
    irq set 0          ; wake SM1
    wait 1 irq 1       ; stall until SM1 raises IRQ 1 (clears it)
.wrap

.program pong_sm1
; #pragma pio_sim config set_base 1 set_count 1
    set pindirs, 1     ; GPIO 1 as an output
.wrap_target
    wait 1 irq 0       ; stall until SM0 raises IRQ 0 (clears it)
    set pins, 1        ; SM1 work: pulse GPIO 1
    set pins, 0
    irq set 1          ; hand control back to SM0
.wrap`,
        config: {
            outBase: 0, setBase: 0, sidesetBase: 0, inBase: 0, jmpPin: 0,
            inShiftDir: 'right', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    },
    shared_program: {
        code: `; One program on three state machines. 'irq ... rel' adds the state
; machine number to the flag index, so each copy talks to its neighbour,
; and 'config sm <n>' gives each copy its own pin.
;
; #pragma pio_sim sm 0 program relay
; #pragma pio_sim sm 1 program relay
; #pragma pio_sim sm 2 program relay
; #pragma pio_sim config sm 0 set_base 0
; #pragma pio_sim config sm 1 set_base 1
; #pragma pio_sim config sm 2 set_base 2
; Start the chain: SM0 waits on IRQ 4, so raise it at clock 2.
; #pragma pio_sim irq set 4 delay 2

.program relay
; #pragma pio_sim config set_count 1
    set pindirs, 1     ; this SM's pin as an output
.wrap_target
    wait 1 irq 4 rel   ; SM n waits on flag 4+n
    set pins, 1 [3]
    set pins, 0
    irq set 5 rel      ; and wakes SM n+1 (flag 4+n+1; SM2 wakes flag 7)
.wrap`,
        config: {
            outBase: 0, setBase: 0, sidesetBase: 0, inBase: 0, jmpPin: 0,
            inShiftDir: 'right', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    },
    irq_handshake: {
        code: `.program ping

; One half of a two state machine handshake. The partner is not
; simulated: these IRQ events play its part (plain comments for pioasm).
;
; Partner sees IRQ 0 and clears it, as its "wait 1 irq 0" would:
; #pragma pio_sim irq clear 0 delay 4 repeat 8
; Partner hands control back, as its "irq set 1" would:
; #pragma pio_sim irq set 1 delay 7 repeat 8

; #pragma pio_sim config set_base 0 set_count 1

    set pindirs, 1  ; GPIO 0 as an output
.wrap_target
    set pins, 1     ; Do this side's work
    set pins, 0
    irq set 0       ; Wake the partner
    wait 1 irq 1    ; Stall until the partner raises IRQ 1 (clears it)
.wrap`,
        config: {
            outBase: 0, setBase: 0, sidesetBase: 0, inBase: 0, jmpPin: 0,
            inShiftDir: 'right', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    }
};

exampleSelect.addEventListener('change', () => {
    const key = exampleSelect.value;
    if (examples[key]) {
        const ex = examples[key];
        codeView.value = ex.code;

        // Every state machine's settings go back to reset values and the
        // example's settings go to SM0, so nothing is left over from the
        // previous source for applyProgramConfig to undo.
        settingsFromDirectives = [new Set(), new Set(), new Set(), new Set()];
        for (const sm of emulator.sms) {
            Object.assign(sm, PIO_SM_CONFIG_DEFAULTS);
            sm.setFifoMode('txrx');
        }
        selectSm(0, false);
        cfgOutBase.value = ex.config.outBase;
        // Anything an example does not mention goes back to its reset value.
        cfgOutCount.value = ex.config.outCount !== undefined ? ex.config.outCount : 0;
        cfgInCount.value = ex.config.inCount !== undefined ? ex.config.inCount : 32;
        cfgFifoMode.value = ex.config.fifoMode !== undefined ? ex.config.fifoMode : 'txrx';
        cfgClkDiv.value = ex.config.clkDiv !== undefined ? ex.config.clkDiv : 1;
        cfgSetBase.value = ex.config.setBase;
        if (ex.config.setCount !== undefined) {
            cfgSetCount.value = ex.config.setCount;
        } else {
            cfgSetCount.value = 5;
        }
        cfgSidesetBase.value = ex.config.sidesetBase;
        cfgInBase.value = ex.config.inBase;
        cfgJmpPin.value = ex.config.jmpPin;
        cfgInShiftDir.value = ex.config.inShiftDir;
        cfgOutShiftDir.value = ex.config.outShiftDir;
        cfgAutoPush.checked = ex.config.autoPush;
        cfgPushThresh.value = ex.config.pushThresh;
        cfgAutoPull.checked = ex.config.autoPull;
        cfgPullThresh.value = ex.config.pullThresh;
        cfgStatusSel.value = ex.config.statusSel !== undefined ? ex.config.statusSel : 0;
        cfgStatusN.value = ex.config.statusN !== undefined ? ex.config.statusN : 0;

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
    lastTxMessage = 'Not pushed yet';
    lastRxMessage = 'Not read yet';
    if (refresh) updateUI();
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

btnPushTx.addEventListener('click', () => {
    const val = parseUserNumber(txInput.value);
    if (!isNaN(val)) {
        if (cur().pushTx(val)) {
            const hex = '0x' + (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
            lastTxMessage = `Pushed: ${hex}`;
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
        btnPushTx.click();
    }
});

btnPopRx.addEventListener('click', () => {
    const val = cur().pullRx();
    if (val === null) {
        lastRxMessage = 'RX FIFO is empty';
        updateUI();
        return;
    }

    const hex = '0x' + (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
    lastRxMessage = `Popped: ${hex}`;
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

// A breakpoint stops the run when any state machine reaches its address.
function atBreakpoint() {
    return emulator.enabledSms().some(sm => breakpoints.has(sm.pc));
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
        // "Max" mode: run many steps per frame via rAF for smooth UI updates.
        const STEPS_PER_FRAME = 200;
        runMode = 'raf';
        const loop = () => {
            if (runMode !== 'raf') return;
            for (let i = 0; i < STEPS_PER_FRAME; i++) {
                emulator.step();
                if (emulator.error) break;
                if (atBreakpoint()) {
                    updateUI();
                    stop();
                    return;
                }
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
        const status = sm.enabled ? sm.status : 'off';
        const values = sm.enabled
            ? [`SM${i}`, sm.program ? sm.program.name : '', null, sm.pc, instrText(sm.pc), hex8(sm.x), hex8(sm.y), sm.cycles]
            : [`SM${i}`, '', null, '', '', '', '', ''];
        values.forEach((v, k) => { if (k !== 2) setText(row.cells[k], v); });
        row.cells[4].title = values[4];
        row.status.className = `sm-status ${status}`;
        setText(row.status, status.toUpperCase());

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

    const smState = emulator.error && sm.status === 'error' ? 'error' : (sm.enabled ? sm.status : 'off');
    regSmStatus.className = `sm-status ${smState}`;
    setText(regSmStatus, smState.toUpperCase());

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

    txFifoList.innerHTML = sm.txFifo.map(v => `<li>0x${v.toString(16).toUpperCase()}</li>`).join('');

    // In the put/get FIFO modes the RX FIFO storage is four registers.
    const fifoMode = sm.fifoMode;
    const rxAsRegs = fifoMode === 'txput' || fifoMode === 'txget' || fifoMode === 'putget';
    rxFifoTitle.textContent = rxAsRegs ? 'RX FIFO registers' : 'RX FIFO';
    rxPopControls.style.display = rxAsRegs ? 'none' : 'flex';
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
        rxFifoList.innerHTML = sm.rxFifo.map(v => `<li>0x${v.toString(16).toUpperCase()}</li>`).join('');
    }
    txPushResult.textContent = lastTxMessage;
    rxPopResult.textContent = lastRxMessage;

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
    codeView.setPcs(emulator.enabledSms().map(s => ({ sm: s.index, pc: s.pc })), sel, true);

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

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    if (history.length === 0 || totalRows === 0) return;

    const maxCycles = 50;
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

    ctx.lineWidth = 1;
    for (let t = 0; t <= maxCycles; t++) {
        const x = t * stepX;
        const absClock = startIndex + t;
        ctx.strokeStyle = (absClock % 5 === 0) ? '#bbb' : '#eee';
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

    ctx.restore();
}

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
