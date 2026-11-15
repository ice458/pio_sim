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
- **Input Stimulus:** Drive input pins with repeating waveforms declared in the source (see below).

## Usage

You can use the live version hosted here:
**[Launch PIO Simulator](https://ice458.github.io/tools/pio_sim/)**

1. Paste or write your PIO assembly code in the editor on the left.
2. Use the control buttons (Run, Step, Reset) to execute the code.
3. Monitor the changes in state machines, FIFOs, and timing diagrams on the right.

## Input Stimulus

To feed a test waveform into an input pin, add a `#pragma pio_sim` comment line to the source. `pioasm` treats it as an ordinary comment, so the same file still assembles for real hardware, and the pin setup is saved with the code.

```
; #pragma pio_sim pin 5 hi 3 low 7                 ; high 3 clocks, low 7, repeats forever
; #pragma pio_sim pin 4 low 9 hi 1 count 5         ; repeats 5 times, then stays high
; #pragma pio_sim pin 3 hi delay 12 low 2 hi 2     ; holds high for 12 clocks first
```

Syntax: `pin <n> [<hi|low> delay <clocks>] <hi|low> <clocks> ... [count <n>]`

- The `<hi|low> <clocks>` pairs form one period. It repeats forever, or `count` times, after which the pin holds its last level.
- An optional leading `<hi|low> delay <clocks>` holds a level once before the first period.
- Clocks are PIO clock cycles counted from reset. Numbers may be `.define` names declared above the pragma.
- The pragma must be on a comment line of its own; a second `;` starts a normal comment.
- A stimulated pin is marked `W` in the GPIO panel and added to the timing chart. Manual toggling has no effect on it, and the waveform is ignored while the pin is set as an output.

## Limitations

- One state machine only. A source with more than one `.program` block is rejected.
- `out exec` / `mov exec` are not supported.
- The IRQ `rel` flag (multi-state-machine addressing) is not supported.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
