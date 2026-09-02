#!/usr/bin/env node
import { main } from './run.ts'

main(process.argv.slice(2)).then((code) => { process.exitCode = code })
