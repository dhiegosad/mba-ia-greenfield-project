import {
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotOwnedException,
  InvalidStatusTransitionException,
} from './video-errors';

describe('Video domain exceptions', () => {
  it('VideoNotFoundException should have code VIDEO_NOT_FOUND and HTTP 404', () => {
    const ex = new VideoNotFoundException();
    expect(ex.errorCode).toBe('VIDEO_NOT_FOUND');
    expect(ex.httpStatus).toBe(404);
    expect(ex.message).toBe('Video not found');
  });

  it('VideoNotReadyException should have code VIDEO_NOT_READY and HTTP 409', () => {
    const ex = new VideoNotReadyException();
    expect(ex.errorCode).toBe('VIDEO_NOT_READY');
    expect(ex.httpStatus).toBe(409);
  });

  it('VideoNotOwnedException should have code VIDEO_NOT_OWNED and HTTP 403', () => {
    const ex = new VideoNotOwnedException();
    expect(ex.errorCode).toBe('VIDEO_NOT_OWNED');
    expect(ex.httpStatus).toBe(403);
  });

  it('InvalidStatusTransitionException should include current/target status in message', () => {
    const ex = new InvalidStatusTransitionException('draft', 'ready');
    expect(ex.errorCode).toBe('INVALID_STATUS_TRANSITION');
    expect(ex.httpStatus).toBe(409);
    expect(ex.message).toBe('Cannot transition from draft to ready');
  });
});
