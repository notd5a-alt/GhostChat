import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useConnectionMonitor from './useConnectionMonitor';
import type { SignalingState } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePc() {
  return new (globalThis as any).RTCPeerConnection() as RTCPeerConnection & {
    restartIce: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
    connectionState: string;
  };
}

/**
 * Render the hook with a shared pcRef.
 *
 * The render function also keeps pc.connectionState in sync with the prop so
 * that timer-callback guards (which read pcRef.current.connectionState directly)
 * see the right value.
 *
 * IMPORTANT: configure the getStats mock on pcRef.current BEFORE calling this
 * function if your test needs specific stats data on the very first poll (which
 * fires synchronously during the initial render).
 */
function renderMonitor(
  pcRef: { current: ReturnType<typeof makePc> },
  initialProps: { connectionState: string; signalingState: SignalingState }
) {
  (pcRef.current as any).connectionState = initialProps.connectionState;
  return renderHook(
    (props) => {
      (pcRef.current as any).connectionState = props.connectionState;
      return useConnectionMonitor(pcRef, props.signalingState, props.connectionState);
    },
    { initialProps }
  );
}

/**
 * Flush enough microtask ticks for a getStats() promise chain to fully settle.
 * The chain is: pollStats() → getStats (async) → setState → then(() => schedulePoll).
 * 20 flushes reliably covers the chain and any React batching.
 */
async function flushStats() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Build a stats Map sufficient for quality-classification tests. */
function makeStatsMap({
  rtt = 0.05,            // seconds — 50 ms
  packetsLost = 0,
  packetsReceived = 1000,
  localCandidateType = 'host' as string,
  remoteCandidateType = 'host' as string,
} = {}) {
  const m = new Map<string, any>();
  m.set('pair1', {
    type: 'candidate-pair',
    state: 'succeeded',
    currentRoundTripTime: rtt,
    localCandidateId: 'local1',
    remoteCandidateId: 'remote1',
  });
  m.set('local1', { type: 'local-candidate', candidateType: localCandidateType });
  m.set('remote1', { type: 'remote-candidate', candidateType: remoteCandidateType });
  m.set('inbound1', {
    type: 'inbound-rtp',
    kind: 'video',
    bytesReceived: 100_000,
    packetsLost,
    packetsReceived,
  });
  return m;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useConnectionMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('returns all-null / all-false values before any connection activity', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'new',
        signalingState: 'open',
      });

      expect(result.current.connectionQuality).toBeNull();
      expect(result.current.connectionType).toBeNull();
      expect(result.current.stats).toBeNull();
      expect(result.current.isRecovering).toBe(false);
      expect(result.current.recoveryFailed).toBe(false);
      expect(result.current.timeoutExpired).toBe(false);
    });

    it('exposes a setTimeoutExpired function', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'new',
        signalingState: 'open',
      });

      expect(typeof result.current.setTimeoutExpired).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // 2. setTimeoutExpired (external setter)
  // -------------------------------------------------------------------------

  describe('setTimeoutExpired', () => {
    it('allows the caller to set timeoutExpired to true', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'new',
        signalingState: 'open',
      });

      act(() => {
        result.current.setTimeoutExpired(true);
      });

      expect(result.current.timeoutExpired).toBe(true);
    });

    it('allows the caller to clear timeoutExpired back to false', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      act(() => {
        result.current.setTimeoutExpired(true);
      });
      expect(result.current.timeoutExpired).toBe(true);

      act(() => {
        result.current.setTimeoutExpired(false);
      });
      expect(result.current.timeoutExpired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Connection timeout (30 s in "connecting")
  // -------------------------------------------------------------------------

  describe('connection timeout', () => {
    it('sets timeoutExpired after 30 s in "connecting" state', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      expect(result.current.timeoutExpired).toBe(false);

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(result.current.timeoutExpired).toBe(true);
    });

    it('does NOT set timeoutExpired before 30 s have elapsed', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      act(() => {
        vi.advanceTimersByTime(29_999);
      });

      expect(result.current.timeoutExpired).toBe(false);
    });

    it('does NOT set timeoutExpired when connectionState is "new" (idle, pre-negotiation)', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'new',
        signalingState: 'open',
      });

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(result.current.timeoutExpired).toBe(false);
    });

    it('skips timeout firing when pc has already reached "connected"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      // Simulate the pc reaching connected before the timer fires without
      // triggering a re-render (so the 30-s timer is still scheduled).
      (pcRef.current as any).connectionState = 'connected';

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      // The guard checks pc.connectionState !== "connected" before setting the flag
      expect(result.current.timeoutExpired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. "connected" state resets timers and recovery state
  // -------------------------------------------------------------------------

  describe('transitioning to "connected"', () => {
    it('resets timeoutExpired when state becomes "connected"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      act(() => {
        result.current.setTimeoutExpired(true);
      });
      expect(result.current.timeoutExpired).toBe(true);

      act(() => {
        rerender({ connectionState: 'connected', signalingState: 'open' });
      });

      expect(result.current.timeoutExpired).toBe(false);
    });

    it('resets isRecovering and recoveryFailed when state becomes "connected"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      act(() => {
        vi.advanceTimersByTime(0);
      });
      // isRecovering is true after the "failed" restart attempts
      expect(result.current.isRecovering).toBe(true);

      act(() => {
        rerender({ connectionState: 'connected', signalingState: 'open' });
      });

      expect(result.current.isRecovering).toBe(false);
      expect(result.current.recoveryFailed).toBe(false);
    });

    it('cancels the pending 30-s timeout timer when "connected" is reached', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      // Advance partway through the timeout
      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      // Become connected — should cancel the remaining timer
      act(() => {
        rerender({ connectionState: 'connected', signalingState: 'open' });
      });

      // Advance past the original 30-s mark
      act(() => {
        vi.advanceTimersByTime(20_000);
      });

      expect(result.current.timeoutExpired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. ICE restart on "disconnected" (after 15 s delay)
  // -------------------------------------------------------------------------

  describe('ICE restart on "disconnected"', () => {
    it('calls restartIce after 15 s in "disconnected" state', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'disconnected',
        signalingState: 'open',
      });

      expect(pc.restartIce).not.toHaveBeenCalled();
      expect(result.current.isRecovering).toBe(false);

      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      // restartIce is called at least once (the isRecovering→true transition also
      // triggers the signaling-recovery effect which may call it once more)
      expect(pc.restartIce).toHaveBeenCalled();
      expect(result.current.isRecovering).toBe(true);
    });

    it('does NOT call restartIce before 15 s have elapsed', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'disconnected',
        signalingState: 'open',
      });

      act(() => {
        vi.advanceTimersByTime(14_999);
      });

      expect(pc.restartIce).not.toHaveBeenCalled();
    });

    it('does not call restartIce again before the restart timeout when state stays "disconnected"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'disconnected',
        signalingState: 'open',
      });

      // Trigger the first restart burst
      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      const callsAfterFirstTrigger = pc.restartIce.mock.calls.length;
      expect(callsAfterFirstTrigger).toBeGreaterThanOrEqual(1);

      // Advance time but NOT enough to fire the restart timeout (15 s) again
      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      // No additional calls in the middle of the restart window
      expect(pc.restartIce.mock.calls.length).toBe(callsAfterFirstTrigger);
    });

    it('does NOT call restartIce when signaling is not "open"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'disconnected',
        signalingState: 'connecting',
      });

      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      // attemptRestart bails early when signalingState !== "open"
      expect(pc.restartIce).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. ICE restart on "failed" (immediate)
  // -------------------------------------------------------------------------

  describe('ICE restart on "failed"', () => {
    it('calls restartIce when state is "failed"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      act(() => {
        vi.advanceTimersByTime(0);
      });

      // Connection-state effect calls restartIce; the isRecovering→true transition
      // also triggers the signaling-recovery effect so it is called at least once
      expect(pc.restartIce).toHaveBeenCalled();
      expect(result.current.isRecovering).toBe(true);
    });

    it('sets isRecovering to true on "failed" restart', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(result.current.isRecovering).toBe(true);
    });

    it('does NOT call restartIce when signaling is not "open" on "failed"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'closed',
      });

      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(pc.restartIce).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Max restart attempts → recoveryFailed
  // -------------------------------------------------------------------------

  describe('max restart attempts', () => {
    it('sets recoveryFailed after MAX_RESTART_ATTEMPTS (3) without success', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      // Let the initial attempts run
      act(() => { vi.advanceTimersByTime(0); });
      expect(result.current.isRecovering).toBe(true);
      expect(result.current.recoveryFailed).toBe(false);

      // Advance repeatedly until recoveryFailed is set.
      // Each restart timeout (15 s) re-triggers attemptRestart when still not connected.
      let iterations = 0;
      while (!result.current.recoveryFailed && iterations < 10) {
        act(() => { vi.advanceTimersByTime(15_000); });
        iterations++;
      }

      expect(result.current.recoveryFailed).toBe(true);
      expect(result.current.isRecovering).toBe(false);
    });

    it('recoveryFailed is reset when connection becomes "connected"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      // Exhaust all restart attempts
      act(() => { vi.advanceTimersByTime(0); });
      for (let i = 0; i < 5; i++) {
        act(() => { vi.advanceTimersByTime(15_000); });
      }
      expect(result.current.recoveryFailed).toBe(true);

      // Successful reconnection resets state
      act(() => {
        rerender({ connectionState: 'connected', signalingState: 'open' });
      });

      expect(result.current.recoveryFailed).toBe(false);
      expect(result.current.isRecovering).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 8. "closed" state resets everything
  // -------------------------------------------------------------------------

  describe('"closed" state resets everything', () => {
    it('clears connectionQuality, connectionType, and stats after polling', async () => {
      const pc = makePc();
      // Set up mock BEFORE creating the hook so the initial poll gets valid data
      pc.getStats.mockResolvedValue(makeStatsMap());
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      // Let the initial synchronous poll complete
      await act(async () => {
        await flushStats();
      });

      // Quality should be populated from the stats poll
      expect(result.current.connectionQuality).not.toBeNull();

      // Now close
      act(() => {
        rerender({ connectionState: 'closed', signalingState: 'open' });
      });

      expect(result.current.connectionQuality).toBeNull();
      expect(result.current.connectionType).toBeNull();
      expect(result.current.stats).toBeNull();
    });

    it('resets isRecovering and recoveryFailed on "closed"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      act(() => { vi.advanceTimersByTime(0); });
      expect(result.current.isRecovering).toBe(true);

      act(() => {
        rerender({ connectionState: 'closed', signalingState: 'open' });
      });

      expect(result.current.isRecovering).toBe(false);
      expect(result.current.recoveryFailed).toBe(false);
    });

    it('resets isRecovering and recoveryFailed on "new"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      act(() => { vi.advanceTimersByTime(0); });
      expect(result.current.isRecovering).toBe(true);

      act(() => {
        rerender({ connectionState: 'new', signalingState: 'open' });
      });

      expect(result.current.isRecovering).toBe(false);
      expect(result.current.recoveryFailed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Stats polling — quality classification
  // -------------------------------------------------------------------------

  describe('quality classification from stats', () => {
    it('classifies "excellent" on first poll with low RTT and zero loss', async () => {
      const pc = makePc();
      // Set up mock BEFORE creating the hook so the initial poll gets valid data
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.05 }));
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      // 50 ms RTT, 0 packet loss → "excellent" (< 100 ms, < 0.5 %)
      expect(result.current.connectionQuality).toBe('excellent');
    });

    it('classifies "good" on first poll with moderate RTT', async () => {
      const pc = makePc();
      // 150 ms RTT, 0 loss → "good" (< 250 ms, < 2 %)
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.15 }));
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionQuality).toBe('good');
    });

    it('classifies "poor" on first poll with high RTT', async () => {
      const pc = makePc();
      // 350 ms RTT, 0 loss → "poor" (< 500 ms, < 5 %)
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.35 }));
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionQuality).toBe('poor');
    });

    it('classifies "critical" on first poll with very high RTT', async () => {
      const pc = makePc();
      // 600 ms RTT → "critical" (≥ 500 ms)
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.6 }));
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionQuality).toBe('critical');
    });

    it('updates connectionQuality on each poll to reflect the latest stats', async () => {
      const pc = makePc();
      // First poll → "excellent"
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.05 }));
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });
      expect(result.current.connectionQuality).toBe('excellent');

      // Second poll with higher RTT → quality reflects the new reading
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.35 }));
      await act(async () => {
        vi.advanceTimersByTime(500); // fast-burst interval fires the next poll
        await flushStats();
      });
      // Quality reflects the new RTT sample
      expect(result.current.connectionQuality).toBe('poor');

      // Third poll back to low RTT → quality improves again
      pc.getStats.mockResolvedValue(makeStatsMap({ rtt: 0.05 }));
      await act(async () => {
        vi.advanceTimersByTime(500);
        await flushStats();
      });
      expect(result.current.connectionQuality).toBe('excellent');
    });

    it('updates the stats object with rtt and packetLoss fields', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(
        makeStatsMap({ rtt: 0.05, packetsLost: 0, packetsReceived: 1000 })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.stats).not.toBeNull();
      // RTT is converted to ms: 0.05 s → 50 ms
      expect(result.current.stats!.rtt).toBeCloseTo(50);
      expect(result.current.stats!.packetLoss).toBe(0);
    });

    it('stops polling stats when connectionState leaves "connected"', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(makeStatsMap());
      const pcRef = { current: pc };
      const { rerender } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      const callsBefore = pc.getStats.mock.calls.length;

      act(() => {
        rerender({ connectionState: 'disconnected', signalingState: 'open' });
      });

      // Advance well past the next polling interval — no new calls should happen
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      expect(pc.getStats.mock.calls.length).toBe(callsBefore);
    });

    it('does not poll stats when connectionState is not "connected"', async () => {
      const pc = makePc();
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
      });

      expect(pc.getStats).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 10. Connection type detection (relay vs direct)
  // -------------------------------------------------------------------------

  describe('connection type detection', () => {
    it('reports "direct" when both candidates are host type', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(
        makeStatsMap({ localCandidateType: 'host', remoteCandidateType: 'host' })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionType).toBe('direct');
    });

    it('reports "relay" when local candidate is relay type', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(
        makeStatsMap({ localCandidateType: 'relay', remoteCandidateType: 'host' })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionType).toBe('relay');
    });

    it('reports "relay" when remote candidate is relay type', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(
        makeStatsMap({ localCandidateType: 'host', remoteCandidateType: 'relay' })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionType).toBe('relay');
    });

    it('reports "direct" when candidates are srflx (server-reflexive, no TURN)', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(
        makeStatsMap({ localCandidateType: 'srflx', remoteCandidateType: 'srflx' })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionType).toBe('direct');
    });

    it('leaves connectionType null when stats have no succeeded candidate-pair', async () => {
      const pc = makePc();
      // No candidate-pair with state "succeeded"
      const m = new Map<string, any>();
      m.set('pair1', {
        type: 'candidate-pair',
        state: 'in-progress',
        currentRoundTripTime: 0.05,
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      });
      pc.getStats.mockResolvedValue(m);
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionType).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Signaling recovery triggers retry
  // -------------------------------------------------------------------------

  describe('signaling recovery triggers ICE restart retry', () => {
    it('does NOT call restartIce when signaling is closed, even after "failed"', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'closed',
      });

      act(() => { vi.advanceTimersByTime(0); });

      expect(pc.restartIce).not.toHaveBeenCalled();
    });

    it('calls restartIce when signaling reopens while isRecovering is true', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { result, rerender } = renderMonitor(pcRef, {
        connectionState: 'failed',
        signalingState: 'open',
      });

      // First restart cycle with open signaling
      act(() => { vi.advanceTimersByTime(0); });
      expect(result.current.isRecovering).toBe(true);

      const callsAfterFirstAttempt = pc.restartIce.mock.calls.length;
      expect(callsAfterFirstAttempt).toBeGreaterThanOrEqual(1);

      // Signaling drops while still in "failed" + isRecovering
      act(() => {
        rerender({ connectionState: 'failed', signalingState: 'closed' });
      });

      // Signaling reopens — the recovery effect fires because
      // signalingState changed back to "open" while isRecovering is true
      act(() => {
        rerender({ connectionState: 'failed', signalingState: 'open' });
      });
      act(() => { vi.advanceTimersByTime(0); });

      // Should have called restartIce at least once more
      expect(pc.restartIce.mock.calls.length).toBeGreaterThan(callsAfterFirstAttempt);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Null pcRef guard
  // -------------------------------------------------------------------------

  describe('null pcRef guard', () => {
    it('does not throw when pcRef.current is null on "failed"', () => {
      const pcRef = { current: null as RTCPeerConnection | null };

      expect(() => {
        renderHook(
          (props) =>
            useConnectionMonitor(pcRef, props.signalingState, props.connectionState),
          {
            initialProps: {
              connectionState: 'failed',
              signalingState: 'open' as SignalingState,
            },
          }
        );
        act(() => { vi.advanceTimersByTime(0); });
      }).not.toThrow();
    });

    it('does not throw when pcRef.current is null on "disconnected" restart', () => {
      const pcRef = { current: null as RTCPeerConnection | null };

      expect(() => {
        renderHook(
          (props) =>
            useConnectionMonitor(pcRef, props.signalingState, props.connectionState),
          {
            initialProps: {
              connectionState: 'disconnected',
              signalingState: 'open' as SignalingState,
            },
          }
        );
        act(() => { vi.advanceTimersByTime(15_000); });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 13. Stats polling — fast initial burst and interval switching
  // -------------------------------------------------------------------------

  describe('fast initial stats burst', () => {
    it('polls stats immediately when state becomes "connected"', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(makeStatsMap());
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      // At minimum the initial synchronous poll fired
      expect(pc.getStats).toHaveBeenCalled();
    });

    it('schedules polls at 500 ms intervals during the fast-burst phase', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(makeStatsMap());
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      // Drain the initial synchronous poll
      await act(async () => {
        await flushStats();
      });

      const afterInitial = pc.getStats.mock.calls.length;
      expect(afterInitial).toBeGreaterThanOrEqual(1);

      // Each 500 ms tick should trigger one additional poll during the burst
      await act(async () => {
        vi.advanceTimersByTime(500);
        await flushStats();
      });

      expect(pc.getStats.mock.calls.length).toBeGreaterThan(afterInitial);
    });

    it('switches to 3 s intervals after the fast-burst phase', async () => {
      const pc = makePc();
      pc.getStats.mockResolvedValue(makeStatsMap());
      const pcRef = { current: pc };
      renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      // Drain initial + 3 fast-burst polls (initial + 3×500ms = 4 polls total)
      await act(async () => { await flushStats(); });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          vi.advanceTimersByTime(500);
          await flushStats();
        });
      }

      const afterBurst = pc.getStats.mock.calls.length;

      // 1 s passes — should NOT trigger a new poll (interval is now 3 s)
      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await flushStats();
      });
      expect(pc.getStats.mock.calls.length).toBe(afterBurst);

      // 2 more seconds (total 3 s since last burst poll) — should trigger one poll
      await act(async () => {
        vi.advanceTimersByTime(2_000);
        await flushStats();
      });
      expect(pc.getStats.mock.calls.length).toBe(afterBurst + 1);
    });
  });

  // -------------------------------------------------------------------------
  // 14. Cleanup on unmount
  // -------------------------------------------------------------------------

  describe('cleanup on unmount', () => {
    it('clears all timers on unmount and does not throw', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { unmount } = renderMonitor(pcRef, {
        connectionState: 'connecting',
        signalingState: 'open',
      });

      expect(() => {
        act(() => { unmount(); });
        // Nothing should fire after unmount
        act(() => { vi.advanceTimersByTime(60_000); });
      }).not.toThrow();
    });

    it('does not call restartIce after unmount', () => {
      const pc = makePc();
      const pcRef = { current: pc };
      const { unmount } = renderMonitor(pcRef, {
        connectionState: 'disconnected',
        signalingState: 'open',
      });

      act(() => { unmount(); });

      act(() => { vi.advanceTimersByTime(15_000); });

      expect(pc.restartIce).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 15. Packet loss affects quality classification
  // -------------------------------------------------------------------------

  describe('packet loss triggers quality downgrade', () => {
    it('classifies "critical" on first poll when packet loss is very high', async () => {
      const pc = makePc();
      // Low RTT but 10% packet loss → "critical" (loss ≥ 5%)
      pc.getStats.mockResolvedValue(
        makeStatsMap({ rtt: 0.05, packetsLost: 100, packetsReceived: 900 })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionQuality).toBe('critical');
    });

    it('classifies "poor" on first poll when packet loss crosses 2% threshold', async () => {
      const pc = makePc();
      // Low RTT but ~3% packet loss → "poor" (loss ≥ 2%, < 5%)
      pc.getStats.mockResolvedValue(
        makeStatsMap({ rtt: 0.05, packetsLost: 30, packetsReceived: 970 })
      );
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      expect(result.current.connectionQuality).toBe('poor');
    });

    it('classifies quality based on video packet loss only, ignoring audio streams', async () => {
      const pc = makePc();
      // Video has 0 loss; audio has very high loss — quality should be "excellent"
      // because the hook only considers video loss for quality classification
      const m = makeStatsMap({ rtt: 0.05, packetsLost: 0, packetsReceived: 1000 });
      m.set('inbound-audio', {
        type: 'inbound-rtp',
        kind: 'audio',
        bytesReceived: 50_000,
        packetsLost: 200,   // very high audio loss
        packetsReceived: 800,
      });
      pc.getStats.mockResolvedValue(m);
      const pcRef = { current: pc };
      const { result } = renderMonitor(pcRef, {
        connectionState: 'connected',
        signalingState: 'open',
      });

      await act(async () => {
        await flushStats();
      });

      // Video has 0 loss, so quality is based on RTT (50 ms) → "excellent"
      expect(result.current.connectionQuality).toBe('excellent');
    });
  });
});
