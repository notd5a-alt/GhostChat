import { renderHook, act } from '@testing-library/react';
import useWebRTC from './useWebRTC';
import type { SignalingHook, SignalingMessage } from '../types';

// Mock channelAuth
vi.mock('../utils/channelAuth', () => ({
  deriveHmacKey: vi.fn().mockResolvedValue({ type: 'secret', algorithm: { name: 'HMAC' } }),
}));

// Mock codecConfig
vi.mock('../utils/codecConfig', () => ({
  preferVideoCodecs: vi.fn(),
  preferAudioCodecs: vi.fn(),
  optimizeOpusInSDP: vi.fn((sdp: string) => sdp),
}));

const createMockSignaling = (): SignalingHook => ({
  connect: vi.fn(),
  send: vi.fn(),
  disconnect: vi.fn(),
  onMessage: vi.fn(),
  state: 'open' as const,
  debugLog: [] as string[],
  addLog: vi.fn(),
  reconnectAttempt: 0,
  maxReconnectAttempts: 5,
});

/** After init(), extract the handler that was passed to signaling.onMessage */
function getMessageHandler(signaling: SignalingHook): (msg: SignalingMessage) => Promise<void> {
  const calls = (signaling.onMessage as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

/** Get the most recently created MockRTCPeerConnection instance */
function getPC(): any {
  const Ctor = globalThis.RTCPeerConnection as any;
  // The mock constructor is called via `new RTCPeerConnection(...)`.
  // We can't easily get the instance from the constructor mock,
  // so we use the pcRef from the hook result instead.
  return Ctor;
}

describe('useWebRTC', () => {
  let signaling: SignalingHook;

  beforeEach(() => {
    signaling = createMockSignaling();
    vi.clearAllMocks();
  });

  // 1. Initial state
  it('has correct initial state', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    expect(result.current.connectionState).toBe('new');
    expect(result.current.chatChannel).toBeNull();
    expect(result.current.fileChannel).toBeNull();
    expect(result.current.hmacKey).toBeNull();
    expect(result.current.callError).toBeNull();
  });

  // 2. init() creates RTCPeerConnection with provided ICE config
  it('creates RTCPeerConnection with provided ICE config', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));
    const customConfig: RTCConfiguration = {
      iceServers: [{ urls: 'stun:custom.stun.server:3478' }],
    };

    act(() => {
      result.current.init(customConfig);
    });

    expect(result.current.pcRef.current).not.toBeNull();
    expect(signaling.onMessage).toHaveBeenCalled();
  });

  // 3. init() uses default ICE config when null passed
  it('creates RTCPeerConnection with default ICE config when null', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    expect(result.current.pcRef.current).not.toBeNull();
  });

  // 4. init() skips if PC already exists
  it('skips init if PC already exists', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current;

    act(() => {
      result.current.init(null);
    });

    // Same PC instance — not recreated
    expect(result.current.pcRef.current).toBe(pc);
    // onMessage called only once
    expect(signaling.onMessage).toHaveBeenCalledTimes(1);
  });

  // 5. Host creates chat and file data channels on init
  it('host creates chat and file data channels', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current as any;
    expect(pc.createDataChannel).toHaveBeenCalledTimes(2);
    expect(pc.createDataChannel).toHaveBeenCalledWith('chat', { ordered: true });
    expect(pc.createDataChannel).toHaveBeenCalledWith('file', { ordered: true });
  });

  // 6. Joiner does not create data channels
  it('joiner does not create data channels on init', () => {
    const { result } = renderHook(() => useWebRTC(signaling, false));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current as any;
    expect(pc.createDataChannel).not.toHaveBeenCalled();
    // Joiner sets ondatachannel handler instead
    expect(pc.ondatachannel).not.toBeNull();
  });

  // 7. peer-joined message triggers offer creation for host
  it('peer-joined triggers offer creation for host', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;

    await act(async () => {
      await handler({ type: 'peer-joined' });
    });

    expect(pc.createOffer).toHaveBeenCalled();
    expect(pc.setLocalDescription).toHaveBeenCalled();
    expect(signaling.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'offer' })
    );
  });

  // 8. offer message is handled — creates answer and sends it
  it('offer message creates answer and sends it (joiner)', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, false));

    act(() => {
      result.current.init(null);
    });

    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;

    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\noffer-sdp\r\n' });
    });

    expect(pc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: 'v=0\r\noffer-sdp\r\n',
    });
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(pc.setLocalDescription).toHaveBeenCalled();
    expect(signaling.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer' })
    );
  });

  // 9. answer message sets remote description
  it('answer message sets remote description', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;

    // Host must be in have-local-offer state for answer to be accepted
    pc.signalingState = 'have-local-offer';

    await act(async () => {
      await handler({ type: 'answer', sdp: 'v=0\r\nanswer-sdp\r\n' });
    });

    expect(pc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0\r\nanswer-sdp\r\n',
    });
  });

  // 10. ice-candidate message adds ICE candidate (after remote description is set)
  it('ice-candidate message adds ICE candidate', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;
    // Remote description must be set first, otherwise candidates are queued
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\nanswer\r\n' };
    const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };

    await act(async () => {
      await handler({ type: 'ice-candidate', candidate });
    });

    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  // 10b. ice-candidate before remote description is queued and flushed
  it('ice-candidate before remote description is queued then flushed', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, false));

    act(() => {
      result.current.init(null);
    });

    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;
    const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };

    // Send candidate before remote description — should be queued
    await act(async () => {
      await handler({ type: 'ice-candidate', candidate });
    });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    // Now send an offer — remote description gets set, candidates flushed
    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\noffer-sdp\r\n' });
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  // 11. peer-disconnected triggers cleanup
  it('peer-disconnected triggers cleanup', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;

    await act(async () => {
      await handler({ type: 'peer-disconnected' });
    });

    // PC should be closed and ref cleared
    expect(pc.close).toHaveBeenCalled();
    expect(result.current.pcRef.current).toBeNull();
    expect(result.current.connectionState).toBe('new');
  });

  // 12. cleanup closes PC, stops media tracks, resets state
  it('cleanup closes PC and resets state', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current as any;

    act(() => {
      result.current.cleanup();
    });

    expect(pc.close).toHaveBeenCalled();
    expect(result.current.pcRef.current).toBeNull();
    expect(result.current.connectionState).toBe('new');
    expect(result.current.chatChannel).toBeNull();
    expect(result.current.fileChannel).toBeNull();
    expect(result.current.hmacKey).toBeNull();
    expect(result.current.callError).toBeNull();
  });

  // 13. startCall gets user media and adds tracks
  it('startCall gets user media and adds tracks', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current as any;

    await act(async () => {
      await result.current.startCall();
    });

    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(pc.addTrack).toHaveBeenCalled();
    expect(result.current.localStream).not.toBeNull();
  });

  // 14. endCall stops media senders
  it('endCall stops media senders and clears local stream', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current as any;

    // Start a call first so there are tracks
    await act(async () => {
      await result.current.startCall();
    });

    const mockTrack = { kind: 'audio', stop: vi.fn(), onended: null, onmute: null, onunmute: null };
    const mockSender = { track: mockTrack };
    pc.getSenders.mockReturnValue([mockSender]);

    act(() => {
      result.current.endCall();
    });

    expect(mockTrack.stop).toHaveBeenCalled();
    expect(pc.removeTrack).toHaveBeenCalledWith(mockSender);
    expect(result.current.localStream).toBeNull();
  });

  // 15. getFingerprint extracts fingerprint from SDP
  it('getFingerprint extracts fingerprint from SDP', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    const pc = result.current.pcRef.current as any;
    pc.localDescription = {
      type: 'offer',
      sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89\r\n',
    };

    const fingerprint = result.current.getFingerprint();
    expect(fingerprint).toBe('AB:CD:EF:01:23:45:67:89');
  });

  it('getFingerprint returns null when no local description', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));

    const fingerprint = result.current.getFingerprint();
    expect(fingerprint).toBeNull();
  });

  // 16. init() with no RTCPeerConnection available sets callError
  it('sets callError when RTCPeerConnection is unavailable', () => {
    const original = globalThis.RTCPeerConnection;
    // Temporarily remove RTCPeerConnection
    delete (globalThis as any).RTCPeerConnection;

    const { result } = renderHook(() => useWebRTC(signaling, true));

    act(() => {
      result.current.init(null);
    });

    expect(result.current.callError).not.toBeNull();
    expect(result.current.callError).toContain('WebRTC is not supported');
    expect(result.current.pcRef.current).toBeNull();

    // Restore
    (globalThis as any).RTCPeerConnection = original;
  });

  // 17. Polite peer (joiner) rolls back and accepts incoming offer during collision
  it('polite peer (joiner) accepts incoming offer during collision', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, false)); // joiner = polite
    act(() => { result.current.init(null); });
    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;

    // Simulate collision: joiner is in have-local-offer state
    pc.signalingState = 'have-local-offer';

    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\ncollision-offer\r\n' });
    });

    // Polite peer should accept the offer (rollback + set remote)
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.createAnswer).toHaveBeenCalled();
  });

  // 18. Impolite peer (host) ignores incoming offer during collision
  it('impolite peer (host) ignores incoming offer during collision', async () => {
    const { result } = renderHook(() => useWebRTC(signaling, true)); // host = impolite
    act(() => { result.current.init(null); });
    const handler = getMessageHandler(signaling);
    const pc = result.current.pcRef.current as any;

    // Simulate collision: host is in have-local-offer state
    pc.signalingState = 'have-local-offer';
    // Clear any prior calls from init
    pc.setRemoteDescription.mockClear();
    pc.createAnswer.mockClear();

    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\ncollision-offer\r\n' });
    });

    // Impolite peer should NOT process the offer
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(pc.createAnswer).not.toHaveBeenCalled();
  });

  // 19. onnegotiationneeded handler is installed and guards on peerPresent
  it('onnegotiationneeded is set up and suppresses negotiation before peer joins', () => {
    const { result } = renderHook(() => useWebRTC(signaling, true));
    act(() => { result.current.init(null); });
    const pc = result.current.pcRef.current as any;

    // onnegotiationneeded handler should be set
    expect(pc.onnegotiationneeded).not.toBeNull();

    // Simulate a changed negotiation state (new track)
    const mockTrack = { kind: 'video', id: 'screen-track', stop: vi.fn() };
    pc.getSenders.mockReturnValue([{ track: mockTrack }]);

    // Before peer-joined, onnegotiationneeded should NOT trigger offer creation
    pc.createOffer.mockClear();
    act(() => { pc.onnegotiationneeded(); });

    // No offer created because no peer is present yet
    expect(pc.createOffer).not.toHaveBeenCalled();
  });
});
