# Hardware verification

What the simulator does is checked against real chips, not only against the datasheets. This page lists how, what has been checked, where the chips and the datasheets disagree, and what is not simulated.

Boards: Raspberry Pi Pico (RP2040, 125 MHz) and Pico 2 (RP2350, 150 MHz), both running MicroPython 1.29.0.

## How it is checked

Each test program runs twice: in the simulator, and on the chip.

1. The simulator assembles the source. Its own instruction words are written into the chip's PIO0 instruction memory, and the state machine registers (PINCTRL, EXECCTRL, SHIFTCTRL, CLKDIV) are built from the simulator's settings. Both sides therefore run exactly the same thing.
2. On the chip, state machine 3 acts as a logic analyser. It runs one `in pins, 8` instruction on every system clock, sampling GPIO 10-17, and DMA drains the samples. It is started on the same clock as the state machines under test.
3. The chip's per-system-clock pin trace is compared with the simulator's. So is the final state: PC, IRQ flags, pin levels and directions, FIFO contents and levels, and the RX FIFO storage registers. For programs that never settle, only the trace is compared.

Each case below is a short program aimed at one behaviour. A case "matches" only if every one of the 256 sampled system clocks and the whole final state agree.

## Results

On the current code, all cases match on both chips. Cases marked RP2350 use features the RP2040 does not have.

| # | Case | RP2040 | RP2350 |
|---|---|---|---|
| 1 | Side-set beats SET on the same pin | match | match |
| 2 | Side-set beats OUT; OUT writes OUT_COUNT pins, zero-extended | match | match |
| 3 | OUT_COUNT 0 writes no pins (OUT and MOV) | match | match |
| 4 | MOV PINS writes OUT_COUNT pins | match | match |
| 5 | SET_COUNT 0 writes no pins or directions | match | match |
| 6 | Autopull: refill stall and free refill, threshold 16 | match | match |
| 7 | Autopull: no pull on the cycle of MOV OSR | match | match |
| 8 | Autopull: background refill on non-OUT cycles; PULL is a fence | match | match |
| 9 | Autopush: push at the threshold, stall when RX is full | match | match |
| 10 | PULL/PUSH variants (noblock, ifempty, iffull); `jmp x--` always decrements | match | match |
| 11 | IRQ on itself: set, `wait 1 irq` clears, clear | match | match |
| 12 | IRQ from a partner state machine, and the IRQ pragma's timing | match | match |
| 13 | Delay cycles start after a stall clears | match | match |
| 14 | A state machine sees its own output 4 clocks later, synchroniser engaged | match | match |
| 15 | JMP PIN does not see the same instruction's side-set | match | match |
| 16 | Wrap: a taken JMP at the wrap top ignores wrap | match | match |
| 17 | OUT EXEC / MOV EXEC timing | match | match |
| 18 | MOV STATUS on the TX FIFO level | match | match |
| 19 | `.fifo tx`: 8-deep TX FIFO | match | match |
| 20 | `.fifo rx`: 8-deep RX FIFO, PUSH stalls when full | match | match |
| 21 | Clock divider 2: own output seen 1 cycle later (bypassed) | match | match |
| 22 | Clock divider 3: own output seen 2 cycles later (synchronised) | match | match |
| 23 | Clock divider 2.5 from `.clock_div`, synchronised loopback | match | match |
| 24 | Clock divider 1.5: fractional period pattern | match | match |
| 25 | Clock divider 1.25: fractional period pattern | match | match |
| 26 | Several SMs: ping/pong handshake (issue #3) | match | match |
| 27 | Several SMs: same pin, same cycle, the highest SM wins | match | match |
| 28 | Several SMs: `irq rel` on one program, three SMs | match | match |
| 29 | Several SMs: IRQ between clock dividers 1 and 3 | match | match |
| 30 | Several SMs: three dividers on one time line (1, 3, 2.5) | match | match |
| 31 | Several SMs: two SMs wait on one flag | match | match |
| 32 | Several SMs: IRQ set and clear on the same cycle | match | match |
| 33 | Several SMs: third SM watches a pin with JMP PIN (issue #3) | pending | pending |
| 34 | Several SMs: per-SM FIFOs and registers | match | match |
| 35 | MOV PINDIRS (RP2350) | - | match |
| 36 | IN_COUNT masks IN, MOV and WAIT PIN (RP2350) | - | match |
| 37 | MOV STATUS on an IRQ flag (RP2350) | - | match |
| 38 | WAIT JMPPIN with an offset (RP2350) | - | match |
| 39 | put: `mov rxfifo[]` (RP2350) | - | match |
| 40 | get: `mov osr, rxfifo[]` (RP2350) | - | match |

"Pending" means the case was added after the last run on the boards.

Separately, the loopback delay was measured with MicroPython for clock dividers 1, 2, 3, 4, 5 and 8 (see below).

## Where the chips and the datasheet differ

The simulator follows the chips.

- **Delay on an EXEC instruction.** The datasheet says the delay of `out exec` / `mov exec` is ignored. On both chips it is not: `out exec, 16 [5]` runs the executed instruction 5 cycles later.
- **IRQ set and clear on the same cycle.** The datasheet does not say what happens when one state machine sets a flag and another clears it on the same cycle. On both chips the set wins.
- **Input latency on RP2350.** The RP2350 datasheet gives no cycle count for a state machine seeing its own output ("Improved GPIO input/output delay and skew" refers to analog timing). Measured, it is the same as the RP2040 datasheet states: 2 system clocks with the input synchroniser bypassed, 4 with it engaged.
- **Input latency with a clock divider.** The datasheets do not say this either. The input path runs on the system clock, not the state machine clock, so counted in state machine cycles the latency gets shorter as the divider grows. Both chips measured the same:

  | Clock divider | Bypassed | Synchronised |
  |---|---|---|
  | 1 | 2 cycles | 4 cycles |
  | 2, 3 | 1 | 2 |
  | 4 and above | 1 | 1 |

- **RX FIFO storage in get mode.** With `.fifo txget`, reading the storage registers from the CPU does not return what the state machine reads, because the read port belongs to the state machine. This is consistent with the datasheet, which assigns each port to one side.

## What is simulated, and how closely

**Checked on hardware** (the cases above): side-set and its priority over OUT/SET, OUT/SET/MOV pin counts, pin directions, autopull and autopush timing, PULL/PUSH variants, IRQ set/clear/wait between and within state machines, `irq rel`, delays and stalls, wrap, EXEC, MOV STATUS, FIFO joining, the RP2350 put/get modes, IN_COUNT, WAIT JMPPIN, MOV PINDIRS, the input synchroniser for a state machine's own outputs, clock dividers (integer and fractional), and several state machines on one time line.

**Follows the datasheets and `pioasm`, not yet checked on hardware:**

- Inputs driven from outside the chip. The input path has been checked only for a state machine reading its own outputs; `#pragma pio_sim pin` waveforms rely on the same model.
- `wait gpio`, IN_BASE wrapping past GPIO 31, `in` from STATUS, MOV STATUS on the RX FIFO level, `jmp !osre`, `mov pc` / `out pc`, side-set to pin directions.
- The assembler, which follows `pioasm`'s grammar. Its instruction encoding is checked against the headers `pioasm` generates for the pico-examples programs, and every program in pico-examples, pico-extras and the pioasm tests assembles.

**Not simulated:**

- Other PIO blocks. `irq prev` / `irq next` address flags that nothing else drives; IRQ pragmas can stand in for them.
- `OUT_STICKY` and `INLINE_OUT_EN`.
- GPIOs above 31 (`GPIOBASE`).
- System-level interrupts and DMA.
- Analog pin behaviour: drive strength, pulls and slew. A pin set as an input reads 0 unless a waveform or a click drives it.
- Instructions written by the CPU to `SMx_INSTR` while running.
