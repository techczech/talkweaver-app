// The Talks browser moved to ./talklist/ (ADR-0008: one model, two view modes).
// This re-export keeps the historical import path (App.tsx imports TalkList + PromptModal here).
export { default, PromptModal, ConfirmModal } from './talklist/TalkList'
