export class ChargingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChargingError';
  }
}
