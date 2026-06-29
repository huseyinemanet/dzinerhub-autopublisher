import { pathToFileURL } from "node:url";
import { connectFramer, publishIfRequested } from "./framer.js";

async function main(): Promise<void> {
  const framer = await connectFramer();

  try {
    const published = await publishIfRequested(framer, true);
    console.log(published ? "Framer site published." : "Framer publish skipped.");
  } finally {
    await framer.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
