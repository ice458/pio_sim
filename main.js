const assembler = new PioAssembler();
const emulator = new PioEmulator();

// UI Elements
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
const txFifoList = document.getElementById('tx-fifo-list');
const rxFifoList = document.getElementById('rx-fifo-list');

const cfgOutBase = document.getElementById('cfg-out-base');
const cfgSetBase = document.getElementById('cfg-set-base');
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
const irqSelect = document.getElementById('irq-select');
const btnSetIrq = document.getElementById('btn-set-irq');
const btnClearIrq = document.getElementById('btn-clear-irq');

const canvas = document.getElementById('timing-chart');
const ctx = canvas.getContext('2d');
const timingChartTitle = document.getElementById('timing-chart-title');

let runInterval = null;

// Initialize GPIO Indicators (32 bits, 31 down to 0)
for (let i = 31; i >= 0; i--) {
    const bit = document.createElement('div');
    bit.className = 'gpio-bit';
    bit.id = `gpio-bit-${i}`;
    bit.textContent = i;
    bit.title = `GPIO ${i}`;
    gpioIndicators.appendChild(bit);
}

// Initialize IRQ Flags
for (let i = 0; i < 8; i++) {
    const flag = document.createElement('div');
    flag.className = 'irq-flag';
    flag.id = `irq-flag-${i}`;
    flag.textContent = `IRQ ${i}`;
    irqFlags.appendChild(flag);
}

// Event Listeners
btnAssemble.addEventListener('click', assembleAndReset);
btnStep.addEventListener('click', step);
btnRunStop.addEventListener('click', toggleRunStop);
btnReset.addEventListener('click', reset);

// Config Listeners
function updateConfig() {
    emulator.outBase = parseInt(cfgOutBase.value);
    emulator.setBase = parseInt(cfgSetBase.value);
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
            updateUI();
            txInput.value = '';
        } else {
            alert('TX FIFO Full');
        }
    }
});

btnSetIrq.addEventListener('click', () => {
    const irq = parseInt(irqSelect.value);
    emulator.irq |= (1 << irq);
    updateUI();
});

btnClearIrq.addEventListener('click', () => {
    const irq = parseInt(irqSelect.value);
    emulator.irq &= ~(1 << irq);
    updateUI();
});

function assembleAndReset() {
    try {
        const source = codeEditor.value;
        const program = assembler.assemble(source);
        emulator.loadProgram(program);
        
        updateConfig();
        
        errorMessage.textContent = '';
        updateUI();
        console.log("Assembled:", program);
    } catch (e) {
        errorMessage.textContent = e.message;
        console.error(e);
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

    // GPIO Output (32-bit)
    gpioHexVal.textContent = '0x' + (emulator.pins >>> 0).toString(16).toUpperCase().padStart(8, '0');
    
    for (let i = 0; i < 32; i++) {
        const bit = document.getElementById(`gpio-bit-${i}`);
        if ((emulator.pins >> i) & 1) {
            bit.classList.add('on');
        } else {
            bit.classList.remove('on');
        }
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
    const ssBase = emulator.sidesetBase;
    const ssCount = emulator.sidesetCount;
    
    if (ssCount > 0) {
        for (let i = 0; i < ssCount; i++) {
            pinsToShow.push(ssBase + i);
        }
    } else {
        // Default to 0-3 if no side set
        pinsToShow = [0, 1, 2, 3];
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
                const prevState = (visibleHistory[t-1].pins >> pin) & 1;
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
