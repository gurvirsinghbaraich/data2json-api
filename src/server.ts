import { serve } from "@hono/node-server";
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
    try {
      const { data: apiKeyRecord } = await supabase
        .from("keys")
        .select()
        .eq("key", apiToken)
        .single();

      const payloadSchema = object({
        input: string(),
        format: looseObject({}),
      });

      try {
        try {
          const { input, format } = parse(payloadSchema, await ctx.req.json());

          let tokensUsed = 0;
          const dynamicSchema = generateDynamicSchema(format);

          const response = await RetryablePromise.retry(
            1,
            async (resolve, reject): Promise<any> => {
              const content = `DATA: \n"${input}"\n\n-----------\nExpected JSON format:\n${JSON.stringify(
                format,
                null,
                2
              )}\n\n-----------\nValid JSON output in expected format:`;

              const openaiResponse = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                  {
                    role: "assistant",
                    content:
                      "You are an AI that converts data into the attached JSON format. You respond with nothing but valid JSON based on the input data. Your output should DIRECTLY be a valid JSON, nothing added before and after. You will begin with the opening curly brace and end with the closing curly brace. Each property in 'Expected JSON format' specified is an object containing the data type of it. Only if you absolutely cannot determine a field, use the value null. You are also responsible for calling special functions. Each special function can be understood as mutation on the data for the following field. Each mutation is starts with '<' and ends with '>'. The mutation can be be natural language used to describe the action that needs to be done on the data.",
                  },
                  { role: "user", content: EXAMPLE_PROMPT },
                  { role: "user", content: EXAMPLE_ANSWER },
                  { role: "user", content },
                ],
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

          await supabase.from("tokens_used").insert({
            used: tokensUsed,
            user_id: apiKeyRecord!.user_id,
          });

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
        { error: "Unauthorized: Invalid API Key", data: null },
        401
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
