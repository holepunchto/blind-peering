module.exports = class Backoff {
  constructor (strategy) {
    this.count = 0
    this.strategy = strategy
    this.timeout = null
    this.resolve = null
    this.destroyed = false
  }

  async run () {
    this.bump()
    if (this.destroyed) return Promise.resolve()

    await new Promise(resolve => {
      const index = this.count >= this.strategy.length ? (this.count - 1) : this.count++
      const time = this.strategy[index]
      const delay = Math.round(1.5 * Math.random() * time)

      this.resolve = resolve
      this.timeout = setTimeout(() => {
        this.timeout = null
        resolve()
      }, delay)
    })
  }

  reset () {
    this.count = 0
    this.bump()
  }

  destroy () {
    this.destroyed = true
    this.bump()
  }

  bump () {
    if (this.timeout !== null) {
      const timeout = this.timeout
      this.timeout = null

      clearTimeout(timeout)
      this.resolve()
    }
  }
}
