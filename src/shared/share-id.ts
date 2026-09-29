// The share id rule the Worker enforces, from its single definition (worker/share-id.ts). Every id
// the Worker hands back is checked with this before it touches a file path or a URL.
export { isShareId, SHARE_ID_LENGTH, SHARE_ID_SOURCE } from '../../worker/share-id.ts'
