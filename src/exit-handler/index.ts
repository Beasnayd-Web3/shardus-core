interface ExitHandler {
  exited: boolean
  syncFuncs: Map<string, Function>
  asyncFuncs: Map<string, Function>
}

class ExitHandler {
  constructor() {
    this.exited = false
    this.syncFuncs = new Map()
    this.asyncFuncs = new Map()
  }

  // Modules can use this to register synchronous cleanup functions
  registerSync(who: string, func: Function) {
    this.syncFuncs.set(who, func)
  }

  // Modules can use this to register asynchronous cleanup functions
  registerAsync(who: string, func: Function) {
    this.asyncFuncs.set(who, func)
  }

  // Cleans up all modules with registered async functions
  async _cleanupAsync() {
    for (const [, func] of this.asyncFuncs) {
      await func()
    }
  }

  // Cleans up all modules with registered sync functions
  _cleanupSync() {
    for (const [, func] of this.syncFuncs) {
      func()
    }
  }

  // Exits after cleaning up with all registered functions
  async exitCleanly(exitProcess = true) {
    if (this.exited) return
    this.exited = true
    this._cleanupSync()
    try {
      await this._cleanupAsync()
    } catch (e) {
      console.error(e)
    }
    // eslint-disable-next-line no-process-exit
    if (exitProcess) process.exit()
  }

  async exitUncleanly() {
    if (this.exited) return
    this.exited = true
    this._cleanupSync()
    try {
      await this._cleanupAsync()
    } catch (e) {
      console.error(e)
    }
    // eslint-disable-next-line no-process-exit
    process.exit(1) // exiting with status 1 causes our modified PM2 to not restart the process
  }

  // Used for adding event listeners for the SIGINT and SIGTERM signals
  addSigListeners(sigint = true, sigterm = true) {
    if (sigint) {
      process.on('SIGINT', async () => {
        // await this.exitCleanly()
        await this.exitUncleanly()
      })
    }
    if (sigterm) {
      process.on('SIGTERM', async () => {
        // await this.exitCleanly()
        await this.exitUncleanly()
      })
    }
  }
}

export default ExitHandler
