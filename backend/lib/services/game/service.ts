import honcho from "../../../utils/honchoClient";
import { GameState, Verdict } from "../../../../shared/schemas/game";
import { IGameService } from "./interface";
import { CoreMessage, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { HonchoService } from "../honcho/service";
import { formatForVercel } from "../../../utils/formatForVercel";
import redis from "../../../utils/redisClient";
import { randomUUID } from "crypto";

export const GameService = (): IGameService => ({
  create: async () => {
    const honchoDefendant = await HonchoService().create();
    const trueVerdict: Verdict = Math.random() > 0.5 ? "guilty" : "innocent";
    const objectiveFactsResponse = await generateText({
      model: anthropic("claude-3-5-sonnet-20240620"),
      system: `We are playing a RPG wherein the user is playing as a judge/jury, interrogating a defendant. In this instance, the defendant
            is ${trueVerdict}.`,
      prompt: `Create a fictional court case for this game. The user is going to interact and ask questions, attempting to determing the guilt
          of the defendant. For now, we are just establishing a (secret) ground truth about the case; so generate a 300 word or so description of an
          interesting case. Give all the OBJECTIVE FACTS about the case from an omniscient perspective, so that this response can be used
          as a reference later on when roleplaying as the defendant. In this instance, the defendant should be ${trueVerdict}.
          `
    });
    const objectiveFacts = objectiveFactsResponse.text;
    const dossierResponse = await generateText({
      model: anthropic("claude-3-5-sonnet-20240620"),
      system: `We are playing a RPG wherein the user is playing as a judge/jury, interrogating a defendant. In this instance, the defendant
      is ${trueVerdict}. We previously established these as the "objective facts" behind the scenes, not all of which the user should know: ${objectiveFacts}`,
      prompt: `Generate a dossier summarizing the case for the user, giving them baseline background from which to begin
      their investigation. Do not reveal information from the objective facts the defendant would have concealed or that gives away the answer. Make this interesting and succinct (~300 words).`
    });
    const dossier = dossierResponse.text;

    // in the redis cache, create a new game with a unique id
    // store the game state according to the schema
    const gameId = randomUUID();
    const newGameState: GameState = {
      // ... initialize your game state according to the schema
      id: gameId,
      startTime: new Date(),
      honchoDefendant,
      caseFacts: { trueVerdict, objectiveFacts },
      dossier,
      gameStage: "prelude"
    };

    await redis.set(`game:${gameId}`, JSON.stringify(newGameState));

    // Add the game ID to a list of games
    await redis.lpush("games:list", gameId);

    return newGameState;
  },
  get: async (id: string) => {
    const gameState = await redis.get(`game:${id}`);
    if (!gameState) {
      throw new Error(`Game with ID ${id} not found`);
    }
    return JSON.parse(gameState);
  },
  processMessage: async (message: string, gameState: GameState) => {
    const { appId, userId, sessionId } = gameState.honchoDefendant;
    // this is the user's input message
    // what should happen here is - user input is stored in Honcho. create a new Honcho message
    // and then - full message history from Honcho is sent as context to AI SDK, with system prompt including dossier
    // AI SDK returns a response, which is then stored in Honcho
    // this same response is then sent back to the user as a response to the input message

    const newHonchoUserMessage =
      await honcho.apps.users.sessions.messages.create(
        appId,
        userId,
        sessionId,
        {
          content: message,
          is_user: true
        }
      );

    const honchoMessages = await HonchoService().getMessageContents({
      appId,
      userId,
      sessionId
    });
    const formattedMessages: CoreMessage[] = formatForVercel(honchoMessages);
    const aiResponse = await generateText({
      model: anthropic("claude-3-5-sonnet-20240620"),
      system: `We are playing a RPG wherein the user is playing as a judge/jury, interrogating a defendant. In this instance, the defendant
      is ${gameState.caseFacts.trueVerdict}. We previously established these as the "objective facts" behind the scenes, not all of which the user should know: ${gameState.caseFacts.objectiveFacts}. FOr the purposes of this prompt, roleplay as the defendant trying to convince them of your innocence.`,
      messages: formattedMessages
    });

    const newHonchoAIMessage = await honcho.apps.users.sessions.messages.create(
      appId,
      userId,
      sessionId,
      { content: aiResponse.text, is_user: false }
    );

    return aiResponse.text;
  }
});
