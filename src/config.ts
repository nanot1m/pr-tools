import {existsSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'

export interface Config {
	repos: string[]
	interval: number
	teams: Record<string, string>
}

export const CONFIG_PATH = `${homedir()}/.config/prs/config.json`

export function loadConfig(): Config {
	const defaults: Config = {repos: [], interval: 120, teams: {}}
	if (!existsSync(CONFIG_PATH)) return defaults
	try {
		return {...defaults, ...(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>)}
	} catch (e) {
		console.error(`Could not parse ${CONFIG_PATH}: ${(e as Error).message}`)
		return defaults
	}
}
