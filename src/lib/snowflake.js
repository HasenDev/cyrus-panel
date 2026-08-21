class Snowflake {
  constructor(options = {}) {
    this.epoch = BigInt(options.epoch || 1704067200000);
    this.workerId = BigInt((options.workerId || 1) & 0x1F);
    this.datacenterId = BigInt((options.datacenterId || 1) & 0x1F);
    this.sequence = 0n;
    this.lastTimestamp = -1n;
    this.workerIdShift = 12n;
    this.datacenterIdShift = 17n;
    this.timestampLeftShift = 22n;
    this.sequenceMask = 4095n;
  }
  generate() {
    let timestamp = BigInt(Date.now());
    if (timestamp < this.lastTimestamp) {
      const drift = this.lastTimestamp - timestamp;
      throw new Error(`Clock moved backwards! Refusing to generate ID for ${drift}ms.`);
    }
    if (this.lastTimestamp === timestamp) {
      this.sequence = (this.sequence + 1n) & this.sequenceMask;
      if (this.sequence === 0n) {
        timestamp = this._waitUntilNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;
    const id =
      ((timestamp - this.epoch) << this.timestampLeftShift) |
      (this.datacenterId << this.datacenterIdShift) |
      (this.workerId << this.workerIdShift) |
      this.sequence;

    return id.toString();
  }
  generateId() {
    return this.generate();
  }
  _waitUntilNextMillis(lastTimestamp) {
    let timestamp = BigInt(Date.now());
    while (timestamp <= lastTimestamp) {
      timestamp = BigInt(Date.now());
    }
    return timestamp;
  }
  deconstruct(id) {
    const bigIntId = BigInt(id);
    const timestamp = Number((bigIntId >> this.timestampLeftShift) + this.epoch);
    const datacenterId = Number((bigIntId >> this.datacenterIdShift) & 0x1Fn);
    const workerId = Number((bigIntId >> this.workerIdShift) & 0x1Fn);
    const sequence = Number(bigIntId & this.sequenceMask);

    return {
      timestamp,
      date: new Date(timestamp),
      datacenterId,
      workerId,
      sequence,
    };
  }
}
const defaultInstance = new Snowflake();

module.exports = {
  Snowflake,
  generate: () => defaultInstance.generate(),
  generateId: () => defaultInstance.generate(),
  deconstruct: (id) => defaultInstance.deconstruct(id),
};