const assembler = new PioAssembler();
const emulator = new PioEmulator();

// UI Elements
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

const gpioHexVal = document.getElementById('gpio-hex-val');
const gpioIndicators = document.getElementById('gpio-indicators');

const irqFlags = document.getElementById('irq-flags');

const canvas = document.getElementById('timing-chart');
const ctx = canvas.getContext('2d');
const timingChartTitle = document.getElementById('timing-chart-title');
const timingPinSelector = document.getElementById('timing-pin-selector');
const selectedTimingPins = new Set();
const programDisplay = document.getElementById('program-display');

let runInterval = null;
let lastRxMessage = 'Not read yet';
let lastTxMessage = 'Not pushed yet';

// Initialize GPIO Indicators (32 bits, 31 down to 0)
for (let i = 31; i >= 0; i--) {
    const bit = document.createElement('div');
    bit.className = 'gpio-bit';
    bit.id = `gpio-bit-${i}`;
    bit.textContent = i;
    bit.title = `GPIO ${i}`;

    // Add click listener to toggle input
    bit.addEventListener('click', (e) => {
        if (e.shiftKey) {
            // Shift+Click: Toggle Direction (Debug feature)
            emulator.pindirs ^= (1 << i);
        } else {
            // Click: Toggle Input Value
            emulator.inputs ^= (1 << i);
        }
        updateUI();
    });

    // Prevent context menu on bits to allow right click if we wanted, 
    // but for now Shift+Click is enough.
    bit.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // Right click could also toggle direction
        emulator.pindirs ^= (1 << i);
        updateUI();
    });

    gpioIndicators.appendChild(bit);
}

// Initialize IRQ Flags
for (let i = 0; i < 8; i++) {
    const flag = document.createElement('div');
    flag.className = 'irq-flag';
    flag.id = `irq-flag-${i}`;
    flag.textContent = `IRQ ${i}`;

    // Click to toggle IRQ
    flag.addEventListener('click', () => {
        emulator.irq ^= (1 << i);
        updateUI();
    });

    irqFlags.appendChild(flag);
}

// Initialize Timing Chart Pin Selector (32 bits, 31 down to 0)
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

// Event Listeners
btnAssemble.addEventListener('click', assembleAndReset);
btnStep.addEventListener('click', step);
btnRunStop.addEventListener('click', toggleRunStop);
btnReset.addEventListener('click', reset);

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

        // Apply config
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

        // Update emulator config
        updateConfig();
    }
});

// Config Listeners
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

btnPushTx.addEventListener('click', () => {
    const val = parseInt(txInput.value);
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

        // Populate Program Display
        programDisplay.innerHTML = '';
        programDisplay.style.display = 'block';

        program.programMap.forEach(item => {
            const div = document.createElement('div');
            div.className = 'program-line';
            div.id = `prog-line-${item.pc}`;

            const pcSpan = document.createElement('span');
            pcSpan.className = 'pc';
            pcSpan.textContent = item.pc.toString().padStart(2, '0');

            const codeSpan = document.createElement('span');
            codeSpan.textContent = item.text;

            div.appendChild(pcSpan);
            div.appendChild(codeSpan);
            programDisplay.appendChild(div);
        });

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

function step() {
    emulator.step();
    updateUI();
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
    runInterval = setInterval(() => {
        emulator.step();
        updateUI();
        if (emulator.status === 'error') {
            stop();
            errorMessage.textContent = emulator.error;
        }
    }, 100); // 10Hz for visibility
}

function stop() {
    if (runInterval) {
        clearInterval(runInterval);
        runInterval = null;
        btnRunStop.textContent = 'Run';
        // Update status to STOPPED if not error
        if (emulator.status !== 'error') {

        }
        updateUI();
    }
}

function step() {
    stop(); // Ensure not running
    emulator.step();
    // Force status update for step
    // If step was successful, status is 'running' (internally), but we are paused.
    // Maybe we should show 'STEP' or 'PAUSED'?
    updateUI(true); // Pass flag for step
}

function reset() {
    stop();
    emulator.reset();
    updateConfig(); // Restore config
    updateUI();
}

function updateUI(isStep = false) {
    // Status
    let displayStatus = emulator.status.toUpperCase();
    if (runInterval) {
        // Running
    } else {
        if (emulator.status === 'running') {
            displayStatus = isStep ? 'STEP' : 'STOPPED';
        }
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

    // Registers
    regPc.textContent = emulator.pc;
    regClock.textContent = emulator.clock;
    regX.textContent = '0x' + emulator.x.toString(16).toUpperCase().padStart(8, '0');
    regY.textContent = '0x' + emulator.y.toString(16).toUpperCase().padStart(8, '0');
    regOsr.textContent = '0x' + emulator.osr.toString(16).toUpperCase().padStart(8, '0');
    regOsrCount.textContent = emulator.osrCount;
    regIsr.textContent = '0x' + emulator.isr.toString(16).toUpperCase().padStart(8, '0');
    regIsrCount.textContent = emulator.isrCount;

    // FIFOs
    txFifoList.innerHTML = emulator.txFifo.map(v => `<li>0x${v.toString(16).toUpperCase()}</li>`).join('');
    rxFifoList.innerHTML = emulator.rxFifo.map(v => `<li>0x${v.toString(16).toUpperCase()}</li>`).join('');
    txPushResult.textContent = lastTxMessage;
    rxPopResult.textContent = lastRxMessage;

    // GPIO Output (32-bit)
    // Show effective pin state (Output or Input)
    const allPins = emulator.getAllPinStates();
    gpioHexVal.textContent = '0x' + (allPins >>> 0).toString(16).toUpperCase().padStart(8, '0');

    for (let i = 0; i < 32; i++) {
        const bit = document.getElementById(`gpio-bit-${i}`);
        const isOut = (emulator.pindirs >> i) & 1;
        const val = (allPins >> i) & 1;

        // Reset classes
        bit.className = 'gpio-bit';

        if (!isOut) {
            bit.classList.add('input');
        }

        if (val) {
            bit.classList.add('on');
        }

        // Add title for tooltip
        bit.title = `GPIO ${i}: ${isOut ? 'Output' : 'Input'} = ${val}`;
    }

    // IRQ Flags
    for (let i = 0; i < 8; i++) {
        const flag = document.getElementById(`irq-flag-${i}`);
        if ((emulator.irq >> i) & 1) {
            flag.classList.add('active');
        } else {
            flag.classList.remove('active');
        }
    }

    // Highlight current line
    const activeLines = programDisplay.querySelectorAll('.program-line.active');
    activeLines.forEach(el => el.classList.remove('active'));

    const currentLine = document.getElementById(`prog-line-${emulator.pc}`);
    if (currentLine) {
        currentLine.classList.add('active');
    }

    // Timing Chart
    drawTimingChart();
}

function drawTimingChart() {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const history = emulator.history;
    if (history.length === 0) return;

    // Determine pins to show
    let pinsToShow = [];
    
    if (selectedTimingPins.size > 0) {
        pinsToShow = Array.from(selectedTimingPins);
    } else {
        // Default: Show SideSet pins and OutBase pins
        const ssBase = emulator.sidesetBase;
        const ssCount = emulator.sidesetCount;
        
        // Add SideSet pins
        if (ssCount > 0) {
            for (let i = 0; i < ssCount; i++) {
                pinsToShow.push(ssBase + i);
            }
        }

        // Add OutBase pins (heuristic: show 4 pins from OutBase)
        // Ideally we would know how many pins are used by OUT instructions, but we don't track that easily.
        // Let's show 4 pins from OutBase as a reasonable default.
        const outBase = emulator.outBase;
        for (let i = 0; i < 4; i++) {
            pinsToShow.push(outBase + i);
        }
        
        // If still empty (e.g. no sideset and outBase=0), default 0-3 is covered by above loop
    }

    // Sort pins and remove duplicates
    pinsToShow.sort((a, b) => a - b);
    pinsToShow = [...new Set(pinsToShow)];

    if (pinsToShow.length > 0) {
        const min = pinsToShow[0];
        const max = pinsToShow[pinsToShow.length - 1];
        if (pinsToShow.length === (max - min + 1)) {
            timingChartTitle.textContent = `Timing Chart (GPIO ${min}-${max})`;
        } else {
            timingChartTitle.textContent = `Timing Chart (GPIO ${pinsToShow.join(',')})`;
        }
    }

    // Draw last N cycles
    const maxCycles = 50;
    const startIndex = Math.max(0, history.length - maxCycles);
    const visibleHistory = history.slice(startIndex);

    const stepX = width / maxCycles;
    const numPins = pinsToShow.length;
    const rowHeight = height / numPins;

    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;

    // Grid
    for (let i = 0; i < numPins; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * rowHeight + rowHeight / 2);
        ctx.lineTo(width, i * rowHeight + rowHeight / 2);
        ctx.stroke();

        ctx.fillStyle = '#000';
        ctx.font = '12px Consolas';
        ctx.fillText(`GPIO ${pinsToShow[i]}`, 5, i * rowHeight + 15);
    }

    ctx.strokeStyle = '#007acc';
    ctx.lineWidth = 2;

    for (let i = 0; i < numPins; i++) {
        const pin = pinsToShow[i];
        ctx.beginPath();
        for (let t = 0; t < visibleHistory.length; t++) {
            const state = (visibleHistory[t].pins >> pin) & 1;
            const x = t * stepX;
            // High is up (y smaller), Low is down (y larger)
            const yCenter = i * rowHeight + rowHeight / 2;
            const y = state ? yCenter - 10 : yCenter + 10;

            if (t === 0) {
                ctx.moveTo(x, y);
            } else {
                const prevState = (visibleHistory[t - 1].pins >> pin) & 1;
                const prevY = prevState ? yCenter - 10 : yCenter + 10;
                ctx.lineTo(x, prevY); // Horizontal
                ctx.lineTo(x, y); // Vertical transition
            }
            ctx.lineTo(x + stepX, y); // Hold
        }
        ctx.stroke();
    }
}

// Initial assemble
assembleAndReset();
