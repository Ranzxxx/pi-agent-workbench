import { runChecks } from "./checks.js";

try {
	const results = await runChecks();
	console.log(JSON.stringify({ sdk: "@earendil-works/pi-coding-agent@0.86.1", results }, null, 2));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
