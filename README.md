# PIO Simulator

![PIO Simulator Screenshot](PIO.png)

A browser-based PIO (Programmable I/O) assembly simulator for the Raspberry Pi Pico (RP2040) and Pico 2 (RP2350).

## Features

- **No Installation Required:** Write and simulate PIO assembly code completely within your web browser.
- **RP2040 & RP2350 Support:** Compatible with both the original Pico and the new Pico 2 architectures.
- **Real-time Visualization:** 
  - Step-by-step execution debugging
  - Scratch registers (X, Y) and Shift registers (ISR, OSR) states
  - TX / RX FIFO buffers
  - GPIO pin states and timing charts (pins, IRQ flags and registers; hover for the values at any clock; scroll or drag back through the last few thousand clocks; marks where `jmp pin` / `wait` read a pin)
- **Interrupts (IRQ) Monitoring:** Clickable IRQ flags to test wait and set behaviors interactively.
- **Several state machines:** Up to four state machines on shared instruction memory, GPIOs and IRQ flags, with a summary of all of them and tabs for each one's details and settings.
- **Simulator pragmas:** Pin waveforms, IRQ events, FIFO data, settings and state machine assignment declared in the source (see below).
- **Examples:** From a blinking pin to UART, SPI, I2S and WS2812 (NeoPixel), each commented and set up by its own pragmas, so it runs as soon as it is loaded.

## Usage

You can use the live version hosted here:
**[Launch PIO Simulator](https://ice458.github.io/tools/pio_sim/)**

1. Paste or write your PIO assembly code in the editor on the left.
2. Use the control buttons (Run, Step, Reset) to execute the code.
3. Monitor the changes in state machines, FIFOs, and timing diagrams on the right.

## How closely it follows the hardware

The emulator follows the PIO chapters of the RP2040 and RP2350 datasheets, and the assembler follows `pioasm` from the pico-sdk. Cycle timing has also been compared with a real RP2040 and RP2350 (a per-cycle pin trace and the final state of about 40 test programs, captured on the chip); where the hardware and the datasheet disagree, the simulator follows the hardware. **[HARDWARE_VERIFICATION.md](HARDWARE_VERIFICATION.md)** lists what was checked, where the chips and the datasheets differ, and what is not simulated.

- **Settings start at the hardware reset values.** In particular OUT Count is 0, so `out pins` writes nothing until you set it, as on a real chip before the C setup code runs. Set the controls the way your `sm_config_*` calls would, or put the settings in the source with `.in` / `.out` / `.set` / `.fifo` / `.mov_status` or a `config` pragma.
- **Input latency.** A pin reaches the state machine 1 system clock late when its synchronizer is bypassed and 3 through the 2-flipflop synchronizer (the reset default). Bypass it per GPIO with Alt+click in the GPIO panel, or `; #pragma pio_sim input_sync_bypass` in the source. A state machine sees its own outputs 2 / 4 system clocks later, the same on RP2040 and RP2350.
- **JMP PIN and the Chip setting.** JMP PIN sees a pin sooner than the other inputs, and differently on each chip: a state machine's own output 1 / 3 system clocks later on RP2040, 2 / 3 on RP2350 (measured; the datasheets do not say). Choose the chip next to "Load Example", or put `; #pragma pio_sim chip rp2040` in the source. With RP2040 chosen, RP2350-only features give a warning.
- **Stepping and delays.** One step is one cycle. The editor highlights the instruction the next step belongs to, so an instruction with a delay `[n]` stays lit for 1 + n steps, marked "delay k/n" on its line. The PC register, like `SMx_ADDR` on the chip (measured), already shows the next instruction during a delay.
- **Clock divider.** One step is one state machine cycle. With a divider (the "Clock div" control, `.clock_div`, or `config clkdiv`), the input path still runs on the system clock, so input latency counted in state machine cycles gets shorter: at 2 the program sees its own output 1 / 2 cycles later, at 4 and above 1 / 1. Fractional dividers spread the extra clocks with a running total, as the hardware does.
- **Pins that are not outputs.** Writing a pin with SET/OUT/MOV/side-set changes PIO's output register, but the pin only follows once it is an output (`set pindirs`, `out pindirs`, side-set `pindirs`, or Shift+click in the GPIO panel). The timing chart draws a pin PIO drives in green, an input in blue (the level on the pin), and a value written but not driven as a dashed line.
- **Pin writes.** OUT and MOV write OUT Count pins, SET writes SET Count pins, and a side-set wins over an OUT/SET to the same pin on the same cycle. When several state machines write a pin on the same cycle, the highest-numbered one wins.
- **IRQ flags between state machines.** A flag set or cleared by one state machine is seen by all of them, itself included, on the next cycle. If one sets and another clears a flag on the same cycle, the set wins (not in the datasheet; measured on both chips).
- **Assembler.** Expressions, `.define`, `public`, labels, `//` and `/* */` comments, `% c-sdk { ... %}` blocks, `.word`, `.origin`, `.pio_version`, and the same range checks as `pioasm`. RP2350-only features (`mov pindirs`, `wait jmppin`, `irq prev/next`, `mov rxfifo[]`) are rejected under `.pio_version 0`.
- **EXEC.** `out exec` / `mov exec` run the instruction on the next cycle after the EXEC instruction's own delay. The datasheet says that delay is ignored, but on both chips it is not.
- **Also supported:** FIFO joining and the RP2350 put/get FIFO modes, `mov x, status` on an IRQ flag.

## Simulator pragmas

Comment lines starting with `; #pragma pio_sim` set up the simulation from the source. `pioasm` treats them as ordinary comments, so the same file still assembles for real hardware and the setup is saved with the code. Clocks are system clocks counted from reset (the same as state machine cycles at clock div 1). Numbers may be `.define` names. A pragma must be on a comment line of its own; a second `;` starts a normal comment.

### Pin waveform

Drive an input pin with a test waveform.

```
; #pragma pio_sim pin 5 hi 3 low 7                 ; high 3 clocks, low 7, repeats forever
; #pragma pio_sim pin 4 low 9 hi 1 count 5         ; repeats 5 times, then stays high
; #pragma pio_sim pin 3 hi delay 12 low 2 hi 2     ; holds high for 12 clocks first
```

Syntax: `pin <n> [<hi|low> delay <clocks>] <hi|low> <clocks> ... [count <n>]`

- The `<hi|low> <clocks>` pairs form one period. It repeats forever, or `count` times, after which the pin holds its last level.
- An optional leading `<hi|low> delay <clocks>` holds a level once before the first period.
- A stimulated pin is marked `W` in the GPIO panel and added to the timing chart. Manual toggling has no effect on it, and the waveform is ignored while the pin is set as an output.

### IRQ event

Raise or clear an IRQ flag at given clocks, the way another state machine's `irq set` / `irq clear` would. This lets you test one half of a multi-state-machine handshake.

```
; #pragma pio_sim irq set 5 delay 4 repeat 12      ; raised at clock 4, 16, 28, ...
; #pragma pio_sim irq clear 5 delay 8 repeat 12    ; cleared at clock 8, 20, 32, ...
; #pragma pio_sim irq set 0 delay 20               ; raised once, at clock 20
```

Syntax: `irq set|clear <n> [delay <clocks>] [repeat <clocks>] [count <n>]`

- The first event is at clock `delay` (default 0). With `repeat` it recurs every that many clocks, forever or `count` times.
- The instruction executed on that clock already sees the new flag value. A real partner state machine is seen one cycle after it executes `irq`, so a partner instruction on cycle N corresponds to `delay N+1`.
- The program can still set and clear the flag itself, and so can you by clicking it. Scheduled flags are added to the timing chart.

### Pin read marks

Mark in the timing chart the clock whose pin level an instruction actually read. The input path lags the pin by a few system clocks (see "Input latency" above), so this is not the clock the instruction ran on.

```
    wait 0 pin 0
; #pragma pio_sim tag_pin_sample E      ; marks the wait above, in lane E
    jmp pin, gate
; #pragma pio_sim tag_pin_sample A      ; marks the jmp pin above, in lane A
```

Syntax: `tag_pin_sample <A-E>`, on a line after a `jmp pin` or `wait ... pin` / `gpio` / `jmppin`.

- A dot in the state machine's colour sits on the pin's row, at the clock that was read. Lane A is at the top of the row, E at the bottom.
- Each instruction's latest read is bold, earlier ones faded. While a `wait` holds, each read is a small dot.
- "Mark all pin reads", above the chart, marks every read without tags: `wait 1` in lane A, `jmp pin` in C, `wait 0` in E.
- Hovering over the chart lists the reads of that clock.

### FIFO data (DMA)

Do the system's side of the FIFOs as a DMA channel would on the chip: write words to the TX FIFO, and read the RX FIFO. Programs such as a UART or I2S output then run without putting every word in by hand.

```
; #pragma pio_sim dma put 7 1 1 3 3                ; these words, then nothing
; #pragma pio_sim dma put 0xF0F000FF 0x80017FFE loop ; these words over and over
; #pragma pio_sim dma put "Hi!\n"                  ; one word per character
; #pragma pio_sim dma get                          ; read every word pushed
```

Syntax: `dma [sm <n>] put <word|"text"> ... [loop]` and `dma [sm <n>] get`

- These act at the system end of the FIFOs, like the Put and Get buttons (`pio_sm_put()` / `pio_sm_get()` in C). Autopull and autopush are the other end: the state machine moving words between the FIFOs and its OSR / ISR. The FIFO panel shows both ends.
- `dma put` tops up the TX FIFO before every step, so the state machine finds a word whenever it pulls. A real DMA channel takes a few clocks to respond, which the simulator leaves out.
- Several `dma put` lines add up to one list. `loop` starts it over at the end; without it, the FIFO runs dry after the last word.
- In a text, `\n`, `\r`, `\t`, `\0`, `\\`, `\"` and `\xNN` are escapes. A `;` or `//` ends the pragma, so write `;` as `\x3B` and `/` as `\x2F`.
- `dma get` empties the RX FIFO after every step, so the program never stalls on a full one. The words read are listed at the bottom of the RX FIFO, with their characters, in place of the Get button.
- Scope is as for `config`: inside a program, the state machines running it; before the first `.program`, every state machine; `sm <n>` names one.

### Settings

Load the settings controls on Assemble, so the pin mapping travels with the source.

```
; #pragma pio_sim config out_base 0 out_count 2 set_base 0 sideset_base 4
; #pragma pio_sim config in_base 0 jmp_pin 5 autopull on pull_thresh 8
```

Syntax: `config <name> <value> [<name> <value> ...]`

| Name | Value |
|---|---|
| `out_base`, `set_base`, `sideset_base`, `in_base`, `jmp_pin` | 0-31 |
| `out_count` | 0-32 |
| `set_count` | 0-5 |
| `in_count` | 1-32 |
| `in_shift`, `out_shift` | `left`, `right` |
| `autopush`, `autopull` | `on`, `off` |
| `push_thresh`, `pull_thresh` | 1-32 |
| `status_sel` | `tx`, `rx`, `irq` |
| `status_n` | 0-31 |
| `fifo` | `txrx`, `tx`, `rx`, `txput`, `txget`, `putget` |
| `clkdiv` | 1-65535, fractions such as `2.5` allowed (1/256 steps) |

`; #pragma pio_sim chip rp2040` (or `rp2350`) selects the chip whose timing to follow, as the Chip control does.

`; #pragma pio_sim input_sync_bypass ...` sets the PIO block's `INPUT_SYNC_BYPASS` register: which GPIOs skip the input synchroniser, as Alt+click in the GPIO panel does. It applies to the whole block, not one state machine. Give GPIO numbers and ranges, one mask in hex or binary, `all` or `none`:

```
; #pragma pio_sim input_sync_bypass 0 2-5      ; GPIO 0, 2, 3, 4 and 5
; #pragma pio_sim input_sync_bypass 0x3D       ; the same, as the register value
; #pragma pio_sim input_sync_bypass all
```

Settings the source does not name keep whatever the controls show. A `config` pragma overrides a directive (`.out`, `.in`, ...) that sets the same thing.

Scope: before the first `.program`, a `config` line applies to every state machine; inside a program, to the state machines running that program. `config sm <n> <name> <value> ...` applies to one state machine only, for example one program on several state machines with different pins.

## Several state machines

Put several `.program` blocks in one source, as `pioasm` allows. Each program goes into the shared 32-word instruction memory, at its `.origin` or else the first free addresses in source order, and its jumps and wrap points are relocated. Symbols defined before the first `.program` are global; labels and `.define`s inside a program are its own.

By default the programs run on SM0, SM1, ... in source order. To choose:

```
; #pragma pio_sim sm 0 program uart_tx        ; SM0 runs uart_tx
; #pragma pio_sim sm 1 program uart_tx        ; so does SM1 ...
; #pragma pio_sim config sm 1 out_base 4      ; ... on other pins
; #pragma pio_sim sm 2 off
```

With any `sm` line, the state machines it does not name stay off. A program no state machine runs is still loaded, so `out exec` or a jump can reach it.

All state machines run on one time line. A step advances to the next system clock on which any of them runs, so state machines with different clock dividers interleave as on the chip. `irq ... rel` adds the state machine number to the flag index. The "State" panel lists every state machine (program, status, PC, instruction, X, Y, cycles); click a row or a tab to see that state machine's registers, FIFOs and settings. The program listing marks each state machine's PC, a breakpoint stops the run when any of them reaches it, and selecting a register in the timing chart shows it for every running state machine.

## Limitations

- One PIO block. `irq prev` / `irq next` address flags of neighbouring blocks, which exist but nothing else drives; IRQ event pragmas can stand in for them.
- `OUT_STICKY` / `INLINE_OUT_EN`, GPIOs above 31 (`GPIOBASE`) and system-level interrupts are not modelled. DMA is not either, beyond what the `dma` pragma stands in for.
- Instructions are accepted without a `.program` line, which `pioasm` would reject.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
