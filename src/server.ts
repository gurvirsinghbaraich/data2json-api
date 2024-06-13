import { serve } from "@hono/node-server";
import { GPTTokens } from "gpt-tokens";
import { Hono } from "hono";
import {
  ValiError,
  array,
  boolean,
  looseObject,
  maxLength,
  minLength,
  nullable,
  number,
  object,
  parse,
  pipe,
  string,
} from "valibot";
import { RetryablePromise } from "../lib/RetryableResponse";
import { createSupabaseClient } from "../lib/createSupabaseClient";
import { openai } from "../lib/openai";
import { EXAMPLE_ANSWER, EXAMPLE_PROMPT } from "../lib/prompt";

const app = new Hono();
const types = ["object", "array", "string", "boolean", "number"];

const inferDataType = (schema: any) => {
  if (!schema?.hasOwnProperty("type")) {
    return Array.isArray(schema) ? "array" : typeof schema;
  }

  return types.includes(schema.type) ? schema.type : "object";
};

const generateDynamicSchema = (schema: any): any => {
  const type = inferDataType(schema);

  switch (type) {
    case "object": {
      const shape: Record<string, any> = {};

      for (const key in schema) {
        if (key !== "type") {
          shape[key] = generateDynamicSchema(schema[key]);
        }
      }

      return object(shape);
    }

    case "array": {
      return array(generateDynamicSchema(schema?.[0]));
    }

    case "string": {
      return nullable(string());
    }

    case "boolean": {
      return nullable(boolean());
    }

    case "number": {
      return nullable(number());
    }

    default: {
      return nullable(string());
    }
  }
};

app.post("/v1", async function (ctx) {
  try {
    const apiToken = parse(
      pipe(string(), minLength(24), maxLength(32)),
      ctx.req.header("X-API-KEY")
    );

    const supabase = createSupabaseClient();
    const payloadSchema = object({
      input: string(),
      format: looseObject({}),
    });

    try {
      const { data: apiKeyRecord } = await supabase
        .from("keys")
        .select()
        .eq("key", apiToken)
        .single();

      if (!apiKeyRecord) {
        return ctx.json(
          { error: "Unauthorized: Invalid API Key", data: null },
          401
        );
      }

      const creditsAvailable = await supabase
        .from("tokens")
        .select()
        .eq("user_id", apiKeyRecord!.user_id)
        .single();

      if (!creditsAvailable.data) {
        return ctx.json(
          {
            error:
              "Unauthorized: Please completed the subscription process in the dashboard (https://www.data2json.xyz/dashboard)",
            data: null,
          },
          401
        );
      }

      try {
        let tokensUsed = 0;
        const { input, format } = parse(payloadSchema, await ctx.req.json());

        const completionConfig = {
          model: "gpt-4o",
          messages: [
            {
              role: "assistant",
              content:
                "You are an AI that converts data into JSON format based on the given template. Respond with nothing but valid JSON directly, starting with { and ending with }. If a field cannot be determined, use null.",
            },
            { role: "user", content: EXAMPLE_PROMPT },
            { role: "user", content: EXAMPLE_ANSWER },
            {
              role: "user",
              content: `DATA: \n"${input}"\n\n-----------\nExpected JSON format:\n${JSON.stringify(
                format,
                null,
                2
              )}\n\n-----------\nValid JSON output in expected format:`,
            },
          ],
        };

        // @ts-ignore
        const usageEstimate = new GPTTokens(completionConfig);
        console.log(creditsAvailable.data.credits, usageEstimate.usedTokens);

        if (!(+creditsAvailable.data.credits > usageEstimate.usedTokens)) {
          return ctx.json(
            {
              error: "Unauthorized: Not enough credits available.",
              data: null,
            },
            401
          );
        }

        const dynamicSchema = generateDynamicSchema(format);

        const response = await RetryablePromise.retry(
          1,
          async (resolve, reject): Promise<any> => {
            // @ts-ignore
            const openaiResponse = await openai.chat.completions.create({
              ...completionConfig,
            });

            const answer = openaiResponse.choices[0].message.content;
            if (openaiResponse.usage?.total_tokens) {
              tokensUsed += openaiResponse.usage.total_tokens;
            }

            try {
              const jsonAnswer = JSON.parse(answer!);
              resolve(parse(dynamicSchema, jsonAnswer));
            } catch (error) {
              reject(error);
            }
          }
        );

        await Promise.all([
          supabase.from("tokens_used").insert({
            used: tokensUsed,
            user_id: apiKeyRecord!.user_id,
          }),
          supabase
            .from("tokens")
            .update({
              credits: (
                +creditsAvailable.data!.credits - tokensUsed
              ).toString(),
            })
            .eq("user_id", apiKeyRecord!.user_id),
        ]);

        return ctx.json({
          error: null,
          data: response,
          tokensUsed: tokensUsed,
        });
      } catch (error) {}
    } catch (error) {
      const issues: Record<string, string> = {};

      (error as ValiError<typeof payloadSchema>).issues.map((issue) => {
        // @ts-ignore
        if (issue.path?.[0]?.key) {
          // @ts-ignore
          issues[issue.path[0].key] = issue.message;
        }
      });

      return ctx.json(
        {
          error: issues,
          data: null,
        },
        {
          status: 400,
        }
      );
    }
  } catch (error) {
    return ctx.json(
      {
        error: "Unauthorized: X-API-KEY header not found!",
        data: null,
      },
      {
        status: 401,
      }
    );
  }
});

serve({
  fetch: app.fetch,
  port: 8080,
});
