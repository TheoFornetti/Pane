import { boundary, type BoundarySchema, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { EngineImage, EngineResult } from './engine';

/** Messages between the daemon and a script process, over the child's IPC channel. */
export type ParentMessage =
  | { type: 'run'; runId: number; code: string; maxOutputChars: number }
  | { type: 'callResult'; callId: number; result: EngineResult }
  /** The foreground notice is up; `text` is the line for the script's result. */
  | { type: 'foregroundNoticeShown'; noticeId: number; text?: string };

export type ChildMessage =
  | { type: 'call'; callId: number; tool: string; args: JsonObject }
  /** A step our layer took, for the replay; the daemon validates it. */
  | { type: 'step'; step: JsonValue }
  /** An action is about to bring `app` to the front; the child waits for `foregroundNoticeShown`. */
  | { type: 'foregroundNotice'; noticeId: number; app: string; action: string }
  | { type: 'done'; runId: number; ok: boolean; text: string; images: EngineImage[] };

export const imageSchema = boundary.object({ mime: boundary.string, base64: boundary.string });

export const childMessageSchema: BoundarySchema<ChildMessage> = boundary.union(
  boundary.object({
    type: boundary.literal('call'),
    callId: boundary.number,
    tool: boundary.nonEmptyString,
    args: boundary.jsonObject,
  }),
  boundary.object({ type: boundary.literal('step'), step: boundary.json }),
  boundary.object({
    type: boundary.literal('foregroundNotice'),
    noticeId: boundary.number,
    app: boundary.string,
    action: boundary.string,
  }),
  boundary.object({
    type: boundary.literal('done'),
    runId: boundary.number,
    ok: boundary.boolean,
    text: boundary.string,
    images: boundary.array(imageSchema),
  }),
);
