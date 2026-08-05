"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck, IconRefresh } from "@/components/icons";

/**
 * #27 recording booth: read the text, record, preview, re-take, accept.
 *
 * #101: a card is now a SENTENCE-GROUPED SEGMENT (~25 words), not a whole beat.
 * Beats run 50-110 words, so a stumble near the end used to cost the entire
 * paragraph; segments break only at sentence boundaries, so a re-take costs one
 * short chunk and never leaves an audible mid-sentence seam. Anything left
 * unrecorded is TTS-filled in the persona voice at assembly — per segment now,
 * so one missing chunk no longer sends a whole beat back to the synthetic voice.
 * Every take is downloadable (ElevenLabs voice-clone source material).
 */

/** One recordable card. `idx` is the take's asset index (a segment take encodes
 *  beat+segment); `label` is what the operator reads on the card. */
type Beat = { idx: number; text: string; label?: string; beatIdx?: number };
type Take = { idx: number; storageKey: string };

export function VoiceoverRecorder({
  productionId,
  beats,
  takes,
}: {
  productionId: string;
  beats: Beat[];
  takes: Take[];
}) {
  const router = useRouter();
  const takeByIdx = new Map(takes.map((t) => [t.idx, t]));
  const [recordingIdx, setRecordingIdx] = useState<number | null>(null);
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = async (idx: number) => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, channelCount: 1 },
      });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mime });
        setPreviewBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
      };
      recorderRef.current = rec;
      rec.start();
      setRecordingIdx(idx);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone access failed");
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    // recordingIdx stays set — the preview/save UI belongs to this beat
  };

  const discardPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewBlob(null);
    setRecordingIdx(null);
  };

  const saveTake = async (idx: number) => {
    if (!previewBlob) return;
    setPendingIdx(idx);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("productionId", productionId);
      fd.set("beatIdx", String(idx));
      fd.set("audio", previewBlob, `take-${idx}.webm`);
      const res = await fetch("/api/voiceover-take", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).error ?? `Upload failed (${res.status})`);
      discardPreview();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPendingIdx(null);
    }
  };

  /** #101: attach a pre-recorded FILE. A narrator working in a DAW exports a
   *  chunk (or the whole read) rather than performing into a browser tab — the
   *  take endpoint already accepts wav/mp3/m4a/ogg, so this is the same path. */
  const uploadFile = async (idx: number, file: File) => {
    setPendingIdx(idx);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("productionId", productionId);
      fd.set("beatIdx", String(idx));
      fd.set("audio", file, file.name);
      const res = await fetch("/api/voiceover-take", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).error ?? `Upload failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPendingIdx(null);
    }
  };

  const deleteTake = async (idx: number) => {
    setPendingIdx(idx);
    try {
      await fetch(`/api/voiceover-take?productionId=${productionId}&beatIdx=${idx}`, {
        method: "DELETE",
      });
      router.refresh();
    } finally {
      setPendingIdx(null);
    }
  };

  const recorded = beats.filter((b) => takeByIdx.has(b.idx)).length;
  const beatCount = new Set(beats.map((b) => b.beatIdx ?? b.idx)).size;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3>Recording booth</h3>
        <span className={`chip ${recorded > 0 ? "good" : ""}`}>
          {recorded > 0 && <span className="d" />}
          {recorded}/{beats.length} segments recorded
        </span>
      </div>
      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Read each card aloud, then save it or re-take it. Cards are{" "}
          <strong>sentence-sized chunks</strong> (~25 words) of your {beatCount} script beats — they never
          break mid-sentence, so a fluff costs one short re-take rather than a whole paragraph.
          Anything you skip is narrated by the channel voice (TTS), so a partial read is fine.
          Every take can be downloaded — clean samples are ideal ElevenLabs voice-clone material.
          Approve the gate above when you&apos;re done.
        </p>
        {error && <p className="badge red">{error}</p>}
        {beats.map((b) => {
          const take = takeByIdx.get(b.idx);
          const isRecording = recordingIdx === b.idx && !previewUrl;
          const hasPreview = recordingIdx === b.idx && previewUrl;
          const busy = pendingIdx === b.idx;
          return (
            <div
              key={b.idx}
              className="panel"
              style={{ marginBottom: 10, borderLeft: take ? "3px solid var(--good, #22c55e)" : undefined }}
            >
              <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <strong style={{ fontSize: 13 }}>{b.label ?? `Beat ${b.idx + 1}`}</strong>
                  {take ? (
                    <span className="chip good">
                      <span className="d" />
                      Your voice
                    </span>
                  ) : (
                    <span className="chip">TTS will fill</span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{b.text}</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {isRecording ? (
                    <button className="btn sm danger" onClick={stopRecording}>
                      Stop
                    </button>
                  ) : hasPreview ? (
                    <>
                      <audio controls src={previewUrl!} style={{ height: 34, maxWidth: 260 }} />
                      <button className="btn sm" onClick={() => saveTake(b.idx)} disabled={busy}>
                        <IconCheck /> {busy ? "Saving…" : "Save take"}
                      </button>
                      <button className="btn ghost sm" onClick={discardPreview} disabled={busy}>
                        Discard
                      </button>
                    </>
                  ) : (
                    <>
                    <label className="btn ghost sm" style={{ cursor: busy ? "default" : "pointer" }}>
                      Upload file
                      <input
                        type="file"
                        accept="audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,audio/webm"
                        style={{ display: "none" }}
                        disabled={recordingIdx !== null || busy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadFile(b.idx, f);
                        }}
                      />
                    </label>
                    <button
                      className="btn ghost sm"
                      onClick={() => startRecording(b.idx)}
                      disabled={recordingIdx !== null || busy}
                    >
                      {take ? (
                        <>
                          <IconRefresh /> Re-record
                        </>
                      ) : (
                        "Record"
                      )}
                    </button>
                    </>
                  )}
                  {take && !isRecording && !hasPreview && (
                    <>
                      <audio controls src={`/api/media/${take.storageKey}`} style={{ height: 34, maxWidth: 260 }} />
                      <a
                        className="btn ghost sm"
                        href={`/api/media/${take.storageKey}`}
                        download={`beat-${b.idx + 1}${take.storageKey.slice(take.storageKey.lastIndexOf("."))}`}
                      >
                        Download
                      </a>
                      <button className="btn ghost sm danger-ink" onClick={() => deleteTake(b.idx)} disabled={busy}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
