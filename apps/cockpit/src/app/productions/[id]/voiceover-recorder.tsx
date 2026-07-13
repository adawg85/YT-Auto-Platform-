"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck, IconRefresh } from "@/components/icons";

/**
 * #27 recording booth: one card per beat — read the text, record, preview,
 * re-take, accept. A flub only re-records that beat; beats left unrecorded
 * are TTS-filled in the persona voice at assembly. Every take is
 * downloadable (ElevenLabs voice-clone source material).
 */

type Beat = { idx: number; text: string };
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

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3>Recording booth</h3>
        <span className={`chip ${recorded > 0 ? "good" : ""}`}>
          {recorded > 0 && <span className="d" />}
          {recorded}/{beats.length} beats recorded
        </span>
      </div>
      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Record each beat in your own voice — read the text aloud, then save or re-take. Beats you
          skip are narrated by the channel voice (TTS). Every take can be downloaded — clean per-beat
          samples are ideal ElevenLabs voice-clone material. Approve the gate above when you&apos;re done.
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
                  <strong style={{ fontSize: 13 }}>Beat {b.idx + 1}</strong>
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
