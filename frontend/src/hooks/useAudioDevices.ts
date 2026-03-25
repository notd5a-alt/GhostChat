import { useState, useEffect, useCallback, useRef } from "react";

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export interface AudioDevicesHook {
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
  selectedInput: string;
  selectedOutput: string;
  setInputDevice: (deviceId: string) => Promise<void>;
  setOutputDevice: (deviceId: string) => void;
  deviceError: string | null;
}

/**
 * Enumerates audio input/output devices and provides switching.
 *
 * - `setInputDevice` acquires a new mic track via getUserMedia and replaces
 *   the active track on both the local stream and the RTCPeerConnection sender.
 * - `setOutputDevice` calls setSinkId on the remote <audio>/<video> element.
 */
export default function useAudioDevices(
  localStreamRef: React.MutableRefObject<MediaStream | null>,
  pcRef: React.MutableRefObject<RTCPeerConnection | null>,
  remoteAudioRef: React.MutableRefObject<HTMLVideoElement | null>,
  setLocalStream: (fn: (s: MediaStream | null) => MediaStream | null) => void,
): AudioDevicesHook {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>("");
  const [selectedOutput, setSelectedOutput] = useState<string>("");
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const selectedInputRef = useRef(selectedInput);
  selectedInputRef.current = selectedInput;

  const enumerate = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === "audioinput" && d.deviceId)
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 6)}` }));
      const outputs = devices
        .filter((d) => d.kind === "audiooutput" && d.deviceId)
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 6)}` }));
      setInputDevices(inputs);
      setOutputDevices(outputs);

      // Auto-select current device if not set
      const currentTrack = localStreamRef.current?.getAudioTracks()[0];
      if (currentTrack && !selectedInputRef.current) {
        const currentId = currentTrack.getSettings().deviceId;
        if (currentId) setSelectedInput(currentId);
      }
    } catch {
      // Permission denied or not available
    }
  }, [localStreamRef]);

  // Enumerate on mount + device changes
  useEffect(() => {
    enumerate();
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () => navigator.mediaDevices.removeEventListener("devicechange", enumerate);
  }, [enumerate]);

  // Re-enumerate when a call starts (labels become available after getUserMedia)
  useEffect(() => {
    const stream = localStreamRef.current;
    if (stream && stream.getAudioTracks().length > 0) {
      enumerate();
    }
  }, [localStreamRef.current?.id, enumerate]);

  const setInputDevice = useCallback(async (deviceId: string) => {
    const pc = pcRef.current;
    const stream = localStreamRef.current;
    if (!stream) return;

    const oldTrack = stream.getAudioTracks()[0];
    if (!oldTrack) return;

    // Get current audio processing state from old track
    const settings = oldTrack.getSettings();
    setDeviceError(null);

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          noiseSuppression: settings.noiseSuppression ?? true,
          echoCancellation: settings.echoCancellation ?? true,
          autoGainControl: settings.autoGainControl ?? true,
        },
      });
      const newTrack = newStream.getAudioTracks()[0];

      // Preserve mute state
      newTrack.enabled = oldTrack.enabled;

      // Replace on peer connection
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) await sender.replaceTrack(newTrack);
      }

      // Replace on local stream
      oldTrack.stop();
      stream.removeTrack(oldTrack);
      stream.addTrack(newTrack);
      setLocalStream((s) => (s ? new MediaStream(s.getTracks()) : s));
      setSelectedInput(deviceId);
    } catch (err) {
      console.error("Failed to switch input device:", err);
      setDeviceError((err as Error).message || "Failed to switch microphone");
    }
  }, [pcRef, localStreamRef, setLocalStream]);

  const setOutputDevice = useCallback((deviceId: string) => {
    const el = remoteAudioRef.current;
    if (el && "setSinkId" in el) {
      (el as any).setSinkId(deviceId).then(() => {
        setSelectedOutput(deviceId);
      }).catch((err: Error) => {
        console.error("Failed to set output device:", err);
        setDeviceError(err.message || "Failed to switch speaker");
      });
    } else {
      setSelectedOutput(deviceId);
    }
  }, [remoteAudioRef]);

  return {
    inputDevices,
    outputDevices,
    selectedInput,
    selectedOutput,
    setInputDevice,
    setOutputDevice,
    deviceError,
  };
}
