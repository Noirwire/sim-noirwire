export const STILL_STARTING = "the service is still starting, try again";

/** The venue's one-time start-up work is not done yet: a request that needs the venue gets a 503. */
export class VenueNotReady extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "VenueNotReady";
  }
}
