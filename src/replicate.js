import Replicate from "replicate";
import fs from "fs/promises";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

const input = {
    task: "transcribe",
    audio: "https://replicate.delivery/pbxt/NO3hMlTgBDzzhGNuOckvSdIerUEJCGPtmcjJzj5HzQKQx9m2/FRN58-0720E%20The%20Placing%20Of%20Deacons%20VGR.m4a",
    language: "french",
    timestamp: "chunk",
    batch_size: 64,
    diarise_audio: false
}

try {
    const output = await replicate.run(
        "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
        { input }
    );

    console.log(output);

    // Save plain text (if available)
    await fs.writeFile("output.txt", output.text || JSON.stringify(output), "utf-8");

    // Save full JSON output
    await fs.writeFile("output.json", JSON.stringify(output, null, 2), "utf-8");

    console.log("✅ Output saved to output.txt and output.json");
} catch (error) {
    console.error("❌ Error:", error);
}
