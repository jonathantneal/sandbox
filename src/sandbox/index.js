let { existsSync: exists } = require('fs')
let { join } = require('path')
let chalk = require('chalk')
let hydrate = require('@architect/hydrate')
let series = require('run-series')
let create = require('@architect/create')
let { chars } = require('@architect/utils')

let env = require('./env')
let ports = require('./ports')
let checkRuntimes = require('./check-runtimes')
let maybeHydrate = require('./maybe-hydrate')
let _arc = require('../arc')
let http = require('../http')
let events = require('../events')
let tables = require('../tables')

let httpPrint = require('./http-print')
let plugins = require('./plugins')
let startupScripts = require('./startup-scripts')

function _start (params, callback) {
  let start = Date.now()
  let { cwd, inventory, restart, symlink, update } = params
  let { inv } = params.inventory

  series([
    // Set up + validate env vars, print the banner
    function (callback) {
      env(params, callback)
    },

    // Get the ports for services
    function (callback) {
      ports(params, callback)
    },

    // Initialize any missing functions on startup
    function (callback) {
      let autocreateEnabled = inv._project.preferences?.create?.autocreate
      if (autocreateEnabled) {
        create(params, callback)
      }
      else callback()
    },

    // Internal Arc services
    function (callback) {
      _arc.start(params, callback)
    },

    // Start DynamoDB (@tables)
    function (callback) {
      tables.start(params, callback)
    },

    // Start event bus (@events) listening for `arc.event.publish` events
    function (callback) {
      events.start(params, callback)
    },

    // Start HTTP + WebSocket (@http, @ws) server
    function (callback) {
      http.start(params, callback)
    },

    // Loop through functions and see if any need dependency hydration
    function (callback) {
      maybeHydrate(params, callback)
    },

    // ... then hydrate Architect project files into functions
    function (callback) {
      let quiet = params.quiet
      if (restart) quiet = true
      hydrate.shared({ inventory, quiet, symlink }, function next (err) {
        if (err) callback(err)
        else {
          if (!restart) update.done('Project files hydrated into functions')
          callback()
        }
      })
    },

    // Pretty print routes
    function (callback) {
      httpPrint(params, callback)
    },

    // Print startup time
    function (callback) {
      if (!restart) {
        let finish = Date.now()
        update.done(`Started in ${finish - start}ms`)
        let isWin = process.platform.startsWith('win')
        let ready = isWin
          ? chars.done
          : chalk.green.dim('❤︎')
        let readyMsg = chalk.white('Local environment ready!')
        update.raw(`${ready} ${readyMsg}\n`)
      }
      callback()
    },

    // Check aws-sdk installation status if installed globally
    function (callback) {
      let dir = __dirname
      if (!dir.startsWith(cwd) && !process.pkg && !restart) {
        let awsDir = join(dir.split('@architect')[0], 'aws-sdk', 'package.json')
        if (!exists(awsDir)) {
          update.warn(`Possible global install of Architect without a global install of AWS-SDK, please run: npm i -g aws-sdk`)
        }
      }
      callback()
    },

    // Check runtime versions
    function (callback) {
      checkRuntimes(params, callback)
    },

    // Kick off any Sandbox startup plugins
    function (callback) {
      let options = { method: 'start', name: 'startup' }
      plugins(params, options, callback)
    },

    // Run startup scripts (if present)
    function (callback) {
      startupScripts(params, callback)
    },
  ],
  function (err) {
    if (err) callback(err)
    else {
      if (process.env.ARC_AWS_CREDS === 'dummy' && !restart) {
        update.verbose.warn('Missing or invalid AWS credentials or credentials file, using dummy credentials (this is probably ok)')
      }
      callback(null, params.ports)
    }
  })
}

function _end (params, callback) {
  series([
    function (callback) {
      let options = { method: 'end', name: 'shutdown' }
      plugins(params, options, callback)
    },
    function (callback) {
      http.end(callback)
    },
    function (callback) {
      events.end(callback)
    },
    function (callback) {
      tables.end(callback)
    },
    function (callback) {
      _arc.end(callback)
    },
  ], callback)
}

module.exports = { _start, _end }
