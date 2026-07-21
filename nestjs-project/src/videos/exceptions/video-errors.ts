import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'You do not own this video');
  }
}

export class InvalidStatusTransitionException extends DomainException {
  constructor(currentStatus: string, targetStatus: string) {
    super(
      'INVALID_STATUS_TRANSITION',
      409,
      `Cannot transition from ${currentStatus} to ${targetStatus}`,
    );
  }
}
