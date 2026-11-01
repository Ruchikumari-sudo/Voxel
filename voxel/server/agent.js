import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Autonomous Triage Agent Step
 * Analyzes image + transcribed text + geo context to make autonomous decisions.
 */
export async function runAutonomousTriage({ imageBuffer, mimeType, voiceText, lat, lon }) {
  const prompt = `
You are the VOXEL Autonomous Civic Operations Agent.
Inspect this citizen hazard submission and execute autonomous triage.

Input context:
- Citizen audio/text transcript: "${voiceText || 'No text provided'}"
- GPS Coordinates: Lat ${lat}, Lon ${lon}

Your tasks:
1. Validate if this is a genuine civic infrastructure defect (not a selfie, document, or spam).
2. Classify defect category: POTHOLE, WATER_LEAKAGE, OPEN_DRAIN, DOWNED_WIRE, GARBAGE_DUMP, or OTHER.
3. Compute Base Severity (0-100) based on immediate physical hazard.
4. Set SLA Tier: 
   - TIER_1 (12h): Imminent life safety risk (e.g. live wire, deep trench on road).
   - TIER_2 (48h): Major mobility/utility disruption (e.g. water burst, standard pothole).
   - TIER_3 (7d): Minor nuisance (e.g. faded signage, mild litter).
5. Extract actionable dispatch tags for field workers.
`;

  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: imageBuffer.toString("base64"), mimeType } },
          { text: prompt }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isValidCivicDefect: { type: Type.BOOLEAN },
          rejectionReason: { type: Type.STRING, nullable: true },
          category: { type: Type.STRING },
          baseSeverity: { type: Type.NUMBER },
          slaTier: { type: Type.STRING, enum: ["TIER_1", "TIER_2", "TIER_3"] },
          urgencyRationale: { type: Type.STRING },
          dispatchNotes: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ["isValidCivicDefect", "category", "baseSeverity", "slaTier", "urgencyRationale"]
      }
    }
  });

  return JSON.parse(response.text);
}