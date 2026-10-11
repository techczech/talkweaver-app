---
title: "TalkWeaver **Play on Next**"
subtitle: "A test talk for media that starts on a press of Next."
series: TalkWeaver
event: Play on next
author: TalkWeaver
date: 7 October 2026
colour: cobalt
outline_version: 2
---
# Play on Next

## Media steps
{id=media-steps}

### A video that waits for Next
{id=video-on-next}

![Test clip](clip.mp4){play-on-next}

The video should not start with the slide; the first press of Next plays it.

### A sound that waits for Next
{id=sound-on-next}

![Short chime](chime.mp3){play-on-next}

The chime should stay silent until the first press of Next.

### Two sounds, one after the other
{id=two-sounds}

![Short chime](chime.mp3){play-on-next}

![Tone](tone.m4a){play-on-next}

The first press of Next plays the chime, and the second press plays the tone.

### A revealed list, then a sound
{id=reveal-then-sound}
{plainlist}{reveal}

- The first item appears on the first press of Next
- The second item appears on the second press of Next

![Short chime](chime.mp3){play-on-next}

### The same video without the option
{id=video-no-option}

![Test clip](clip.mp4)

This video plays only from the presenter's Play control; Next moves on to the following slide.
