import {Output} from '@oclif/parser'
import Command, {flags} from '@oclif/command'
import * as fs from 'fs'
import {spawn} from 'child_process'
import {Backend} from './backend'
import * as getStdin from 'get-stdin'
import {getEnvironment} from './environments'
import {join} from 'path'
import yaml = require('yaml')
import fetch from 'node-fetch'

const {stat, mkdir} = fs.promises

export async function createDirectory(path: string) {
  try {
    const file = await stat(path)
    if (!file.isDirectory()) {
      throw new Error('Output path is not a directory')
    }
  } catch {
    mkdir(path, {recursive: true})
  }
}

export function getFileName(path: string): string {
  const parts = new URL(path).pathname.split('/')
  return parts[parts.length - 1]
}

export function runCommand(command: string, ...args: string[]): Promise<number> {
  return new Promise(resolve => {
    spawn(command, args, {
      stdio: 'inherit',
    }).on('close', resolve)
  })
}

export async function writeFile(path: string, data: string) {
  if (path === '/dev/stdout') {
    await new Promise(resolve => process.stdout.write(data, resolve))
  } else {
    await fs.promises.writeFile(path, data)
  }
}

export async function readFile(path: string): Promise<Buffer> {
  if (path === '/dev/stdin') {
    return getStdin.buffer()
  }
  return fs.promises.readFile(path)
}

export abstract class BaseCommand extends Command {
  static commonFlags = {
    environment: flags.string({description: 'Environment', default: 'prod', hidden: true}),
  }

  static endpointFlags = {
    endpoint: flags.string({char: 'e', description: 'Slash GraphQL Endpoint'}),
    token: flags.string({char: 't', description: 'Slash GraphQL Backend API Tokens'}),
  }

  // Async so that we can eventually implement logic, and automatically get tokens
  async backendFromOpts(opts: Output<{ endpoint: string | undefined; token: string | undefined; environment: string }, any>): Promise<Backend> {
    if (opts.flags.endpoint && opts.flags.token) {
      return new Backend(opts.flags.endpoint, opts.flags.token)
    }
    if (opts.flags.endpoint) {
      const {apiServer, authFile} = getEnvironment(opts.flags.environment)
      const token = await this.getEndpointJWTToken(apiServer, authFile, opts.flags.endpoint)
      if (token) {
        return new Backend(opts.flags.endpoint, token)
      }
    }
    throw new Error('Please pass an endpoint and api token')
  }

  async getEndpointJWTToken(apiServer: string, authFile: string, endpoint: string) {
    const host = new URL(endpoint).host
    const token = await this.getAccessToken(authFile)
    if (!token) {
      return null
    }
    const backendsResponse = await fetch(`${apiServer}/deployments`, {
      headers: {Authorization: `Bearer ${token}`},
    })
    if (backendsResponse.status !== 200) {
      return null
    }
    const deployments = await backendsResponse.json()
    for (const {url, jwtToken} of deployments) {
      if (url === host) {
        return jwtToken as string
      }
    }
    return null
  }

  async getAccessToken(authFile: string) {
    try {
      const yamlContent = await readFile(join(this.config.configDir, authFile))
      const {apiTime, access_token, expires_in} = yaml.parse(yamlContent.toString())
      if (new Date() > new Date(new Date(apiTime).getTime() + (1000 * expires_in))) {
        this.warn('Access Token Expired')
        return null
      }
      return access_token as string
    } catch {
      return null
    }
  }
}
