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

On the current code, all cases match on both chips: 44 on RP2040, 53 on RP2350 (2026-11-17). Cases marked RP2350 use features the RP2040 does not have. The simulator is set to the chip it is compared with.

| # | Case | RP2040 | RP2350 |
|---|---|---|---|
| 1 | Sideset beats SET on the same pin | match | match |
| 2 | Sideset beats OUT; OUT writes OUT_COUNT pins, zero-extended | match | match |
| 3 | OUT_COUNT 0 writes no pins (OUT and MOV) | match | match |
| 4 | MOV PINS writes OUT_COUNT pins | match | match |
| 5 | SET_COUNT 0 writes no pins or directions | match | match |
| 6 | Autopull: refill stall and free refill, threshold 16 | match | match |
| 7 | Autopull: no pull on the cycle of MOV OSR | match | match |
| 8 | Autopull: background refill on non-OUT cycles, PULL is a fence | match | match |
| 9 | Autopush: push at threshold, stall when RX full | match | match |
| 10 | PULL/PUSH variants, jmp x-- always decrements | match | match |
| 11 | IRQ on itself: set, wait 1 clears, clear | match | match |
| 12 | IRQ from a partner state machine (pragma timing) | match | match |
| 13 | Delay starts after a stall clears | match | match |
| 14 | Own output, synchroniser engaged (4 cycles) | match | match |
| 15 | JMP PIN does not see its own side-set | match | match |
| 16 | Wrap: taken JMP at wrap top ignores wrap | match | match |
| 17 | OUT EXEC and MOV EXEC timing, delay before the executee | match | match |
| 18 | MOV STATUS on TX FIFO level | match | match |
| 19 | .fifo tx: 8-deep TX FIFO | match | match |
| 20 | .fifo rx: 8-deep RX FIFO, push stalls when full | match | match |
| 21 | Latency of jmp pin, synchroniser bypassed | match | match |
| 22 | Latency of wait gpio, synchroniser bypassed | match | match |
| 23 | Latency of in pins, synchroniser bypassed | match | match |
| 24 | Latency of jmp pin, synchroniser engaged | match | match |
| 25 | Latency of wait gpio, synchroniser engaged | match | match |
| 26 | Latency of in pins, synchroniser engaged | match | match |
| 27 | Latency of jmp pin, clkdiv 2, synchroniser bypassed | match | match |
| 28 | Latency of jmp pin, clkdiv 3, synchroniser bypassed | match | match |
| 29 | Latency of jmp pin, clkdiv 2, synchroniser engaged | match | match |
| 30 | Latency of jmp pin, clkdiv 3, synchroniser engaged | match | match |
| 31 | Latency of wait jmppin (RP2350), synchroniser bypassed | - | match |
| 32 | Latency of wait jmppin (RP2350), synchroniser engaged | - | match |
| 33 | Latency of wait jmppin vs jmp pin, side by side (RP2350) | - | match |
| 34 | Clkdiv 2: own output seen 1 cycle later (bypassed) | match | match |
| 35 | Clkdiv 3: own output seen 2 cycles later (synchronised) | match | match |
| 36 | Clkdiv 2.5 via .clock_div: synchronised loopback | match | match |
| 37 | Clkdiv 1.5: fractional period pattern | match | match |
| 38 | Clkdiv 1.25: fractional period pattern | match | match |
| 39 | Several SMs: ping/pong handshake from issue #3 | match | match |
| 40 | Several SMs: same pin, same cycle, highest SM wins | match | match |
| 41 | Several SMs: irq rel on one program, three SMs | match | match |
| 42 | Several SMs: IRQ across clock dividers (1 and 3) | match | match |
| 43 | Several SMs: three dividers on one time line (1, 3, 2.5) | match | match |
| 44 | Several SMs: two SMs wait on one flag | match | match |
| 45 | Several SMs: IRQ set and clear on the same cycle | match | match |
| 46 | Several SMs: issue #3 example, third SM watches a pin with JMP PIN | match | match |
| 47 | Several SMs: per-SM FIFOs and registers | match | match |
| 48 | MOV PINDIRS (RP2350) | - | match |
| 49 | IN_COUNT masks IN, MOV and WAIT PIN (RP2350) | - | match |
| 50 | MOV STATUS on an IRQ flag (RP2350) | - | match |
| 51 | WAIT JMPPIN with offset (RP2350) | - | match |
| 52 | Put: MOV RXFIFO[] (RP2350) | - | match |
| 53 | Get: MOV OSR, RXFIFO[] (RP2350) | - | match |

Separately, the loopback delay was measured with MicroPython for clock dividers 1, 2, 3, 4, 5 and 8 (see below).

## Where the chips and the datasheet differ

The simulator follows the chips.

- **Delay on an EXEC instruction.** The datasheet says the delay of `out exec` / `mov exec` is ignored. On both chips it is not: `out exec, 16 [5]` runs the executed instruction 5 cycles later.
- **IRQ set and clear on the same cycle.** The datasheet does not say what happens when one state machine sets a flag and another clears it on the same cycle. On both chips the set wins.
- **Input latency.** The RP2350 datasheet gives no cycle count for a state machine seeing its own output, and the RP2040 one gives 2 system clocks with the input synchroniser bypassed and 4 with it engaged. Measured, that holds on both chips for IN PINS, WAIT PIN, WAIT GPIO, MOV x, PINS and, on RP2350, WAIT JMPPIN.
- **JMP PIN is faster, and differs between the chips.** Neither datasheet says so. Measured, JMP PIN sees a state machine's own output sooner than the other inputs do, and not by the same amount on both chips:

  | Own output seen by | RP2040 bypassed / synchronised | RP2350 bypassed / synchronised |
  |---|---|---|
  | IN PINS, WAIT PIN, WAIT GPIO, WAIT JMPPIN | 2 / 4 system clocks | 2 / 4 |
  | JMP PIN | 1 / 3 | 2 / 3 |

  This is why the simulator has a Chip setting (and `; #pragma pio_sim chip rp2040`). It was found when issue #3's example, a third state machine watching another's pin with JMP PIN, matched on RP2350 but not on RP2040.
- **Input latency with a clock divider.** The datasheets do not say this either. The input path runs on the system clock, not the state machine clock, so counted in state machine cycles the latency gets shorter as the divider grows (JMP PIN too). Both chips measured the same for IN PINS:

  | Clock divider | Bypassed | Synchronised |
  |---|---|---|
  | 1 | 2 cycles | 4 cycles |
  | 2, 3 | 1 | 2 |
  | 4 and above | 1 | 1 |

- **RX FIFO storage in get mode.** With `.fifo txget`, reading the storage registers from the CPU does not return what the state machine reads, because the read port belongs to the state machine. This is consistent with the datasheet, which assigns each port to one side.

## What is simulated, and how closely

**Checked on hardware** (the cases above): side-set and its priority over OUT/SET, OUT/SET/MOV pin counts, pin directions, autopull and autopush timing, PULL/PUSH variants, IRQ set/clear/wait between and within state machines, `irq rel`, delays and stalls, wrap, EXEC, MOV STATUS, FIFO joining, the RP2350 put/get modes, IN_COUNT, WAIT JMPPIN, MOV PINDIRS, the input synchroniser for a state machine's own outputs, clock dividers (integer and fractional), and several state machines on one time line.

**Follows the datasheets and `pioasm`, not yet checked on hardware:**

- Inputs driven from outside the chip. The input path has been checked only for state machines reading outputs of the same PIO block; `#pragma pio_sim pin` waveforms rely on the same model, taking a pin change from outside as one system clock earlier than an output write reaching the pad.
- IN_BASE wrapping past GPIO 31, `in` from STATUS, MOV STATUS on the RX FIFO level, `jmp !osre`, `mov pc` / `out pc`, side-set to pin directions.
- The assembler, which follows `pioasm`'s grammar. Its instruction encoding is checked against the headers `pioasm` generates for the pico-examples programs, and every program in pico-examples, pico-extras and the pioasm tests assembles.

**Not simulated:**

- Other PIO blocks. `irq prev` / `irq next` address flags that nothing else drives; IRQ pragmas can stand in for them.
- `OUT_STICKY` and `INLINE_OUT_EN`.
- GPIOs above 31 (`GPIOBASE`).
- System-level interrupts and DMA.
- Analog pin behaviour: drive strength, pulls and slew. A pin set as an input reads 0 unless a waveform or a click drives it.
- Instructions written by the CPU to `SMx_INSTR` while running.
