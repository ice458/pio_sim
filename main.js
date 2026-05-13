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

const cfgOutBase = document.getElementById('cfg-out-base');
const cfgSetBase = document.getElementById('cfg-set-base');
const cfgSetCount = document.getElementById('cfg-set-count');
const cfgSidesetBase = document.getElementById('cfg-sideset-base');
const cfgInBase = document.getElementById('cfg-in-base');
const cfgJmpPin = document.getElementById('cfg-jmp-pin');
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
const programDisplay = document.getElementById('program-display');

let runInterval = null;
let runMode = null; // 'interval' | 'raf'
const breakpoints = new Set();
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

.wrap_target
    set pins, 1   ; Turn on
    set pins, 0   ; Turn off
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

; Setup: Load Period into ISR
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

; Config:
; OUT/SET Base: 0
; SIDESET Base: 4
; IN Base: 0
; JMP PIN: 5

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
            outBase: 0, setBase: 0, sidesetBase: 4, inBase: 0, jmpPin: 5,
            inShiftDir: 'left', outShiftDir: 'right',
            autoPush: false, pushThresh: 32, autoPull: false, pullThresh: 32
        }
    }
};

exampleSelect.addEventListener('change', () => {
    const key = exampleSelect.value;
    if (examples[key]) {
        const ex = examples[key];
        codeEditor.value = ex.code;

        cfgOutBase.value = ex.config.outBase;
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

function updateConfig() {
    emulator.outBase = parseInt(cfgOutBase.value);
    emulator.setBase = parseInt(cfgSetBase.value);
    emulator.setCount = parseInt(cfgSetCount.value);
    emulator.sidesetBase = parseInt(cfgSidesetBase.value);
    emulator.inBase = parseInt(cfgInBase.value);
    emulator.jmpPin = parseInt(cfgJmpPin.value);
    emulator.inShiftDir = cfgInShiftDir.value;
    emulator.outShiftDir = cfgOutShiftDir.value;
    emulator.autoPush = cfgAutoPush.checked;
    emulator.pushThresh = parseInt(cfgPushThresh.value);
    emulator.autoPull = cfgAutoPull.checked;
    emulator.pullThresh = parseInt(cfgPullThresh.value);
    emulator.statusSel = parseInt(cfgStatusSel.value);
    emulator.statusN = parseInt(cfgStatusN.value);
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
        if (emulator.pushTx(val)) {
            const hex = '0x' + (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
            lastTxMessage = `Pushed: ${hex}`;
            updateUI();
            txInput.value = '';
        } else {
            lastTxMessage = 'TX FIFO is full';
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
    const val = emulator.pullRx();
    if (val === null) {
        lastRxMessage = 'RX FIFO is empty';
        updateUI();
        return;
    }

    const hex = '0x' + (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
    lastRxMessage = `Popped: ${hex}`;
    updateUI();
});

function assembleAndReset() {
    try {
        const source = codeEditor.value;
        const program = assembler.assemble(source);
        emulator.loadProgram(program);
        emulator.programMap = program.programMap;

        programDisplay.innerHTML = '';
        programDisplay.style.display = 'block';

        program.programMap.forEach(item => {
            const div = document.createElement('div');
            div.className = 'program-line';
            div.id = `prog-line-${item.pc}`;
            div.title = 'Click line number to toggle breakpoint';

            const bpSpan = document.createElement('span');
            bpSpan.className = 'bp-marker';
            bpSpan.textContent = ' ';
            bpSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleBreakpoint(item.pc);
            });

            const pcSpan = document.createElement('span');
            pcSpan.className = 'pc';
            pcSpan.textContent = item.pc.toString().padStart(2, '0');
            pcSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleBreakpoint(item.pc);
            });

            const codeSpan = document.createElement('span');
            codeSpan.textContent = item.text;

            div.appendChild(bpSpan);
            div.appendChild(pcSpan);
            div.appendChild(codeSpan);
            programDisplay.appendChild(div);
        });

        // Clear stale breakpoints when re-assembling; instruction mapping may differ.
        breakpoints.clear();

        updateConfig();

        errorMessage.textContent = '';
        updateUI();
        console.log("Assembled:", program);
    } catch (e) {
        errorMessage.textContent = e.message;
        console.error(e);
        programDisplay.style.display = 'none';
    }
}

function toggleBreakpoint(pc) {
    if (breakpoints.has(pc)) {
        breakpoints.delete(pc);
    } else {
        breakpoints.add(pc);
    }
    const line = document.getElementById(`prog-line-${pc}`);
    if (line) line.classList.toggle('breakpoint', breakpoints.has(pc));
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
                if (emulator.status === 'error') break;
                if (breakpoints.has(emulator.pc)) {
                    updateUI();
                    stop();
                    return;
                }
            }
            updateUI();
            if (emulator.status === 'error') {
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
            if (emulator.status === 'error') {
                stop();
                errorMessage.textContent = emulator.error;
                return;
            }
            if (breakpoints.has(emulator.pc)) {
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
    updateUI(true);
}

function reset() {
    stop();
    emulator.reset();
    updateConfig();
    updateUI();
}

function updateUI(isStep = false) {
    let displayStatus = emulator.status.toUpperCase();
    if (!runInterval && emulator.status === 'running') {
        displayStatus = isStep ? 'STEP' : 'STOPPED';
    }

    statusIndicator.textContent = displayStatus;

    if (displayStatus === 'RUNNING') {
        statusIndicator.style.backgroundColor = '#4caf50';
        statusIndicator.style.color = 'white';
    } else if (displayStatus === 'STALLED') {
        statusIndicator.style.backgroundColor = '#ff9800';
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

    regPc.textContent = emulator.pc;
    regClock.textContent = emulator.clock;
    regX.textContent = '0x' + emulator.x.toString(16).toUpperCase().padStart(8, '0');
    regY.textContent = '0x' + emulator.y.toString(16).toUpperCase().padStart(8, '0');
    regOsr.textContent = '0x' + emulator.osr.toString(16).toUpperCase().padStart(8, '0');
    regOsrCount.textContent = emulator.osrCount;
    regIsr.textContent = '0x' + emulator.isr.toString(16).toUpperCase().padStart(8, '0');
    regIsrCount.textContent = emulator.isrCount;

    txFifoList.innerHTML = emulator.txFifo.map(v => `<li>0x${v.toString(16).toUpperCase()}</li>`).join('');
    rxFifoList.innerHTML = emulator.rxFifo.map(v => `<li>0x${v.toString(16).toUpperCase()}</li>`).join('');
    txPushResult.textContent = lastTxMessage;
    rxPopResult.textContent = lastRxMessage;

    const allPins = emulator.getAllPinStates();
    gpioHexVal.textContent = '0x' + (allPins >>> 0).toString(16).toUpperCase().padStart(8, '0');

    const bypassMask = emulator.inputSyncBypass >>> 0;
    const ff1 = emulator.inputsFf1 >>> 0;
    const ff2 = emulator.inputsFf2 >>> 0;
    gpioFf1HexVal.textContent = '0x' + ff1.toString(16).toUpperCase().padStart(8, '0');
    gpioFf2HexVal.textContent = '0x' + ff2.toString(16).toUpperCase().padStart(8, '0');
    // FF stages are dead weight when every pin bypasses the synchronizer.
    const ffVisible = bypassMask !== 0xFFFFFFFF ? '' : 'none';
    gpioFf1Row.style.display = ffVisible;
    gpioFf2Row.style.display = ffVisible;

    for (let i = 0; i < 32; i++) {
        const bit = document.getElementById(`gpio-bit-${i}`);
        const isOut = (emulator.pindirs >> i) & 1;
        const val = (allPins >> i) & 1;
        const bypass = (bypassMask >> i) & 1;

        bit.className = 'gpio-bit';
        if (!isOut) bit.classList.add('input');
        if (val) bit.classList.add('on');
        // Mark inputs whose synchronizer is engaged (hardware default).
        if (!isOut && !bypass) bit.classList.add('synced');

        const ff2Bit = (ff2 >> i) & 1;
        const syncNote = isOut
            ? ''
            : (bypass
                ? ' [SYNC BYPASSED]'
                : ` [SYNC ENGAGED — PIO sees ${ff2Bit}]`);
        bit.title = `GPIO ${i}: ${isOut ? 'Output' : 'Input'} = ${val}${syncNote}`;
    }

    for (let i = 0; i < 8; i++) {
        const flag = document.getElementById(`irq-flag-${i}`);
        if ((emulator.irq >> i) & 1) {
            flag.classList.add('active');
        } else {
            flag.classList.remove('active');
        }
    }

    const activeLines = programDisplay.querySelectorAll('.program-line.active');
    activeLines.forEach(el => el.classList.remove('active'));

    const currentLine = document.getElementById(`prog-line-${emulator.pc}`);
    if (currentLine) {
        currentLine.classList.add('active');
        const parent = currentLine.parentElement;
        if (parent) {
            const lineTop = currentLine.offsetTop - parent.offsetTop;
            const lineBottom = lineTop + currentLine.offsetHeight;
            if (lineTop < parent.scrollTop || lineBottom > parent.scrollTop + parent.clientHeight) {
                currentLine.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            }
        }
    }

    drawTimingChart();
}

function drawTimingChart() {
    const history = emulator.history;

    let pinsToShow = [];

    if (selectedTimingPins.size > 0) {
        pinsToShow = Array.from(selectedTimingPins);
    } else {
        const ssBase = emulator.sidesetBase;
        const ssCount = emulator.sidesetCount;
        for (let i = 0; i < ssCount; i++) {
            pinsToShow.push(ssBase + i);
        }
        const outBase = emulator.outBase;
        for (let i = 0; i < 4; i++) {
            pinsToShow.push(outBase + i);
        }
    }

    pinsToShow.sort((a, b) => a - b);
    pinsToShow = [...new Set(pinsToShow)];

    const regsToShow = TIMING_REGS.filter(r => selectedTimingRegs.has(r.key));

    if (pinsToShow.length > 0) {
        const min = pinsToShow[0];
        const max = pinsToShow[pinsToShow.length - 1];
        let titleStr;
        if (pinsToShow.length === (max - min + 1)) {
            titleStr = `GPIO ${min}-${max}`;
        } else {
            titleStr = `GPIO ${pinsToShow.join(',')}`;
        }
        if (regsToShow.length > 0) {
            titleStr += ` + ${regsToShow.map(r => r.label).join(', ')}`;
        }
        timingChartTitle.textContent = `Timing Chart (${titleStr})`;
    } else if (regsToShow.length > 0) {
        timingChartTitle.textContent = `Timing Chart (${regsToShow.map(r => r.label).join(', ')})`;
    }

    const numPins = pinsToShow.length;
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

    const stepX = width / maxCycles;

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
        ctx.lineTo(width, yCenter);
        ctx.stroke();
    }

    ctx.strokeStyle = '#007acc';
    ctx.lineWidth = 2;

    for (let i = 0; i < numPins; i++) {
        const pin = pinsToShow[i];
        const yCenter = i * pinRowHeight + pinRowHeight / 2;
        ctx.beginPath();
        for (let t = 0; t < visibleHistory.length; t++) {
            const state = (visibleHistory[t].pins >> pin) & 1;
            const x = t * stepX;
            const y = state ? yCenter - 10 : yCenter + 10;

            if (t === 0) {
                ctx.moveTo(x, y);
            } else {
                const prevState = (visibleHistory[t - 1].pins >> pin) & 1;
                const prevY = prevState ? yCenter - 10 : yCenter + 10;
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
            }
            ctx.lineTo(x + stepX, y);
        }
        ctx.stroke();
    }

    ctx.font = '12px Consolas';
    for (let i = 0; i < numPins; i++) {
        const label = `GPIO ${pinsToShow[i]}`;
        const yBaseline = i * pinRowHeight + 15;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = '#fff';
        ctx.fillRect(3, yBaseline - 11, tw + 4, 14);
        ctx.fillStyle = '#000';
        ctx.fillText(label, 5, yBaseline);
    }

    for (let i = 0; i < numRegs; i++) {
        const reg = regsToShow[i];
        const yTop = pinAreaHeight + i * regRowHeight + 4;
        const yBot = pinAreaHeight + (i + 1) * regRowHeight - 4;
        const yMid = (yTop + yBot) / 2;

        ctx.font = '12px Consolas';
        const labelOffsetX = ctx.measureText(reg.label).width + 12;

        ctx.strokeStyle = '#c2185b';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = '#000';

        let segStart = 0;
        for (let t = 1; t <= visibleHistory.length; t++) {
            const ended = (t === visibleHistory.length) ||
                          (visibleHistory[t][reg.key] !== visibleHistory[t - 1][reg.key]);
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

            const text = reg.format(visibleHistory[segStart][reg.key]);
            const segWidth = xEnd - xStart;
            const segHeight = yBot - yTop;
            const visStart = (segStart === 0) ? Math.max(xStart, labelOffsetX) : xStart;
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
        const tw = ctx.measureText(reg.label).width;
        const yBaseline = yTop + 12;
        ctx.fillStyle = '#fff';
        ctx.fillRect(3, yBaseline - 11, tw + 4, 14);
        ctx.fillStyle = '#000';
        ctx.fillText(reg.label, 5, yBaseline);
    }
}

// Restore code from localStorage (if any) before initial assemble.
try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && saved !== '') {
        codeEditor.value = saved;
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
