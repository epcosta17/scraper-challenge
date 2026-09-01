#!/usr/bin/env node
import { main } from './cli/run.ts'

main(process.argv.slice(2)).then((code) => { process.exitCode = code })
