// What the slide picker hands its host so the command palette can run the picker's talk-search
// actions (talk search 08). Each action runs against the picker's live state and answers true when
// it acted, or a sentence saying why there was nothing to act on (the host shows it as a notice).

export type PickerCommandOutcome = true | string

export interface SlidePickerCommands {
  /** Puts the cursor in Find a talk — now if the picker is open, else as soon as it opens. */
  focusFindTalk: () => void
  /** Find a talk's ⌘↵: the highlighted talk beside what is open. */
  addTalkBeside: () => PickerCommandOutcome
  /** O: the focused result's talk beside the results. */
  talkBeside: () => PickerCommandOutcome
  /** Closes the talk beside the results. */
  closeTalkBeside: () => PickerCommandOutcome
  /** ⇧⌘↵: selects the focused slide's whole section (its heading slide and every slide under it). */
  selectWholeSection: () => PickerCommandOutcome
}

/** What "Find a talk" hands the picker: its input, and its ⌘↵ on the highlighted row. */
export interface FindTalkCommands {
  focus: () => void
  addActiveBeside: () => PickerCommandOutcome
}

export const NOTHING_BESIDE = 'No talk is open beside the results.'
