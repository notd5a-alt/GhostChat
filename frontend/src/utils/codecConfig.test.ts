import { describe, it, expect, vi, beforeEach } from 'vitest';
import { optimizeOpusInSDP, preferVideoCodecs, preferAudioCodecs } from './codecConfig';

const SAMPLE_SDP = [
  'v=0',
  'o=- 123 2 IN IP4 127.0.0.1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 103',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:103 ISAC/16000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 H264/90000',
].join('\r\n');

const SDP_WITH_FMTP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=0',
].join('\r\n');

describe('optimizeOpusInSDP', () => {
  it('adds Opus optimization params when no fmtp exists', () => {
    const result = optimizeOpusInSDP(SAMPLE_SDP);
    expect(result).toContain('usedtx=1');
    expect(result).toContain('useinbandfec=1');
    expect(result).toContain('maxaveragebitrate=48000');
  });

  it('merges with existing fmtp params (overrides existing)', () => {
    const result = optimizeOpusInSDP(SDP_WITH_FMTP);
    expect(result).toContain('useinbandfec=1'); // overrides 0
    expect(result).toContain('minptime=10'); // preserves existing
    expect(result).toContain('usedtx=1');
  });

  it('returns SDP unchanged when no Opus line exists', () => {
    const noOpusSdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
    expect(optimizeOpusInSDP(noOpusSdp)).toBe(noOpusSdp);
  });

  it('returns empty/null SDP unchanged', () => {
    expect(optimizeOpusInSDP('')).toBe('');
  });
});

describe('preferVideoCodecs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls setCodecPreferences with VP9 first when available', () => {
    const setCodecPreferences = vi.fn();
    // Enable the prototype method
    (RTCRtpTransceiver as any).prototype.setCodecPreferences = vi.fn();
    (RTCRtpReceiver.getCapabilities as ReturnType<typeof vi.fn>).mockReturnValue({
      codecs: [
        { mimeType: 'video/VP8' },
        { mimeType: 'video/AV1' },
        { mimeType: 'video/VP9' },
        { mimeType: 'video/H264' },
      ],
    });

    const mockPc = {
      getTransceivers: vi.fn().mockReturnValue([{
        sender: { track: { kind: 'video' } },
        receiver: { track: { kind: 'video' } },
        setCodecPreferences,
      }]),
    } as unknown as RTCPeerConnection;

    preferVideoCodecs(mockPc);
    expect(setCodecPreferences).toHaveBeenCalledTimes(1);

    const codecs = setCodecPreferences.mock.calls[0][0];
    expect(codecs[0].mimeType).toBe('video/VP9');
    expect(codecs[1].mimeType).toBe('video/VP8');
    expect(codecs[2].mimeType).toBe('video/H264');
    expect(codecs[3].mimeType).toBe('video/AV1');
  });

  it('does nothing when setCodecPreferences is not supported', () => {
    delete (RTCRtpTransceiver as any).prototype.setCodecPreferences;
    const mockPc = {
      getTransceivers: vi.fn().mockReturnValue([]),
    } as unknown as RTCPeerConnection;

    // Should not throw
    preferVideoCodecs(mockPc);
  });
});

describe('preferAudioCodecs', () => {
  it('sorts Opus to the top', () => {
    const setCodecPreferences = vi.fn();
    (RTCRtpTransceiver as any).prototype.setCodecPreferences = vi.fn();
    (RTCRtpReceiver.getCapabilities as ReturnType<typeof vi.fn>).mockReturnValue({
      codecs: [
        { mimeType: 'audio/G722' },
        { mimeType: 'audio/opus' },
        { mimeType: 'audio/PCMU' },
      ],
    });

    const mockPc = {
      getTransceivers: vi.fn().mockReturnValue([{
        sender: { track: { kind: 'audio' } },
        receiver: { track: { kind: 'audio' } },
        setCodecPreferences,
      }]),
    } as unknown as RTCPeerConnection;

    preferAudioCodecs(mockPc);
    const codecs = setCodecPreferences.mock.calls[0][0];
    expect(codecs[0].mimeType).toBe('audio/opus');
  });
});
