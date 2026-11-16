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
  - GPIO pin states and timing charts
- **Interrupts (IRQ) Monitoring:** Clickable IRQ flags to test wait and set behaviors interactively.
- **Several state machines:** Up to four state machines on shared instruction memory, GPIOs and IRQ flags, with a summary of all of them and tabs for each one's details and settings.
- **Simulator pragmas:** Pin waveforms, IRQ events, settings and state machine assignment declared in the source (see below).

## Usage

You can use the live version hosted here:
**[Launch PIO Simulator](https://ice458.github.io/tools/pio_sim/)**

1. Paste or write your PIO assembly code in the editor on the left.
2. Use the control buttons (Run, Step, Reset) to execute the code.
3. Monitor the changes in state machines, FIFOs, and timing diagrams on the right.

## How closely it follows the hardware

The emulator follows the PIO chapters of the RP2040 and RP2350 datasheets, and the assembler follows `pioasm` from the pico-sdk. Cycle timing has also been compared with a real RP2040 and RP2350 (a per-cycle pin trace and the final state of about 30 test programs, captured on the chip); where the hardware and the datasheet disagree, the simulator follows the hardware.

- **Settings start at the hardware reset values.** In particular OUT Count is 0, so `out pins` writes nothing until you set it, as on a real chip before the C setup code runs. Set the controls the way your `sm_config_*` calls would, or put the settings in the source with `.in` / `.out` / `.set` / `.fifo` / `.mov_status` or a `config` pragma.
- **Input latency.** A pin reaches the state machine 1 system clock late when its synchronizer is bypassed and 3 through the 2-flipflop synchronizer (the reset default). A state machine sees its own outputs 2 / 4 system clocks later, the same on RP2040 and RP2350.
- **Clock divider.** One step is one state machine cycle. With a divider (the "Clock div" control, `.clock_div`, or `config clkdiv`), the input path still runs on the system clock, so input latency counted in state machine cycles gets shorter: at 2 the program sees its own output 1 / 2 cycles later, at 4 and above 1 / 1. Fractional dividers spread the extra clocks with a running total, as the hardware does.
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
- `OUT_STICKY` / `INLINE_OUT_EN`, GPIOs above 31 (`GPIOBASE`), system-level interrupts and DMA are not modelled.
- Instructions are accepted without a `.program` line, which `pioasm` would reject.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
