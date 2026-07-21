// Generated from CC Switch v3.16.5. Run scripts/sync-cc-switch-providers.ts to refresh.
import type { AgentProviderPreset } from "./provider-presets";

export const CC_SWITCH_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    "id": "codex-default",
    "label": "OpenAI Official",
    "runtimeAgentId": "codex",
    "providerName": "OpenAI Official",
    "modelProvider": "openai",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.6-sol",
        "label": "GPT-5.6-Sol",
        "reasoningEfforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra"
        ],
        "defaultReasoningEffort": "low"
      },
      {
        "id": "gpt-5.6-terra",
        "label": "GPT-5.6-Terra",
        "reasoningEfforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra"
        ],
        "defaultReasoningEffort": "medium"
      },
      {
        "id": "gpt-5.6-luna",
        "label": "GPT-5.6-Luna",
        "reasoningEfforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "defaultReasoningEffort": "medium"
      }
    ],
    "usesApiKey": false,
    "requiresOAuth": true,
    "websiteUrl": "https://chatgpt.com/codex",
    "category": "official"
  },
  {
    "id": "codex-shengsuanyun",
    "label": "Shengsuanyun",
    "runtimeAgentId": "codex",
    "providerName": "shengsuanyun",
    "modelProvider": "shengsuanyun",
    "baseUrl": "https://router.shengsuanyun.com/api/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "openai/gpt-5.5",
        "label": "openai/gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://www.shengsuanyun.com/?from=CH_4HHXMRYF",
    "apiKeyUrl": "https://www.shengsuanyun.com/?from=CH_4HHXMRYF",
    "category": "aggregator"
  },
  {
    "id": "codex-patewayai",
    "label": "PatewayAI",
    "runtimeAgentId": "codex",
    "providerName": "patewayai",
    "modelProvider": "patewayai",
    "baseUrl": "https://api.pateway.ai/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.5",
        "label": "gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://pateway.ai",
    "apiKeyUrl": "https://pateway.ai/?ch=etzpm8&aff=WB6M6F67#/",
    "category": "third_party"
  },
  {
    "id": "codex-agentplan",
    "label": "火山Agentplan",
    "runtimeAgentId": "codex",
    "providerName": "ark_agentplan",
    "modelProvider": "ark-agentplan",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "ark-code-latest",
        "label": "ark-code-latest"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://www.volcengine.com/activity/codingplan?ac=MMAP8JTTCAQ2&rc=6J6FV5N2&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "apiKeyUrl": "https://www.volcengine.com/activity/codingplan?ac=MMAP8JTTCAQ2&rc=6J6FV5N2&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "category": "cn_official"
  },
  {
    "id": "codex-byteplus",
    "label": "BytePlus",
    "runtimeAgentId": "codex",
    "providerName": "byteplus",
    "modelProvider": "byteplus",
    "baseUrl": "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "ark-code-latest",
        "label": "ark-code-latest"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://www.byteplus.com/en/product/modelark?utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "apiKeyUrl": "https://www.byteplus.com/en/product/modelark?utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "category": "cn_official"
  },
  {
    "id": "codex-volcengine",
    "label": "DouBaoSeed",
    "runtimeAgentId": "codex",
    "providerName": "doubaoseed",
    "modelProvider": "doubaoseed",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "doubao-seed-2-1-pro-260628",
        "label": "doubao-seed-2-1-pro-260628"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?apikey=%7B%7D&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "apiKeyUrl": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?apikey=%7B%7D&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "category": "cn_official"
  },
  {
    "id": "codex-qiniu",
    "label": "Qiniu",
    "runtimeAgentId": "codex",
    "providerName": "qiniu",
    "modelProvider": "qiniu",
    "baseUrl": "https://api.qnaigc.com/bypass/openai/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.5",
        "label": "gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://s.qiniu.com/nMvAvy",
    "apiKeyUrl": "https://s.qiniu.com/nMvAvy",
    "category": "aggregator"
  },
  {
    "id": "codex-azure-openai",
    "label": "Azure OpenAI",
    "runtimeAgentId": "codex",
    "providerName": "Azure OpenAI",
    "modelProvider": "azure-openai",
    "baseUrl": "https://YOUR_RESOURCE_NAME.openai.azure.com/openai",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.5",
        "label": "gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/codex",
    "category": "third_party"
  },
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "runtimeAgentId": "codex",
    "providerName": "deepseek",
    "modelProvider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "deepseek-v4-flash",
        "label": "deepseek-v4-flash"
      },
      {
        "id": "deepseek-v4-pro",
        "label": "deepseek-v4-pro"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://platform.deepseek.com",
    "apiKeyUrl": "https://platform.deepseek.com/api_keys",
    "category": "cn_official"
  },
  {
    "id": "glm",
    "label": "Zhipu GLM",
    "runtimeAgentId": "codex",
    "providerName": "zhipu_glm",
    "modelProvider": "zhipu-glm",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "glm-5.2",
        "label": "glm-5.2"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://open.bigmodel.cn",
    "apiKeyUrl": "https://www.bigmodel.cn/claude-code?ic=RRVJPB5SII",
    "category": "cn_official"
  },
  {
    "id": "codex-baidu-qianfan-coding-plan",
    "label": "Baidu Qianfan Coding Plan",
    "runtimeAgentId": "codex",
    "providerName": "qianfan_coding",
    "modelProvider": "qianfan-coding",
    "baseUrl": "https://qianfan.baidubce.com/v2/coding",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "qianfan-code-latest",
        "label": "qianfan-code-latest"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://cloud.baidu.com/product/qianfan_modelbuilder",
    "apiKeyUrl": "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    "category": "cn_official"
  },
  {
    "id": "codex-bailian",
    "label": "Bailian",
    "runtimeAgentId": "codex",
    "providerName": "bailian",
    "modelProvider": "bailian",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "qwen3-coder-plus",
        "label": "qwen3-coder-plus"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://bailian.console.aliyun.com",
    "apiKeyUrl": "https://bailian.console.aliyun.com/#/api-key",
    "category": "cn_official"
  },
  {
    "id": "kimi",
    "label": "Kimi",
    "runtimeAgentId": "codex",
    "providerName": "kimi",
    "modelProvider": "kimi",
    "baseUrl": "https://api.moonshot.cn/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "kimi-k2.7-code",
        "label": "kimi-k2.7-code"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://platform.kimi.com?aff=cc-switch",
    "apiKeyUrl": "https://platform.kimi.com/console/api-keys?aff=cc-switch",
    "category": "cn_official"
  },
  {
    "id": "codex-kimi-for-coding",
    "label": "Kimi For Coding",
    "runtimeAgentId": "codex",
    "providerName": "kimi_coding",
    "modelProvider": "kimi-coding",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "kimi-for-coding",
        "label": "kimi-for-coding"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://www.kimi.com/code/?aff=cc-switch",
    "apiKeyUrl": "https://www.kimi.com/code/?aff=cc-switch",
    "category": "cn_official"
  },
  {
    "id": "codex-stepfun",
    "label": "StepFun",
    "runtimeAgentId": "codex",
    "providerName": "stepfun",
    "modelProvider": "stepfun",
    "baseUrl": "https://api.stepfun.com/step_plan/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "step-3.7-flash",
        "label": "step-3.7-flash"
      },
      {
        "id": "step-3.5-flash-2603",
        "label": "step-3.5-flash-2603"
      },
      {
        "id": "step-3.5-flash",
        "label": "step-3.5-flash"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://platform.stepfun.com/step-plan",
    "apiKeyUrl": "https://platform.stepfun.com/interface-key",
    "category": "cn_official"
  },
  {
    "id": "codex-modelscope",
    "label": "ModelScope",
    "runtimeAgentId": "codex",
    "providerName": "modelscope",
    "modelProvider": "modelscope",
    "baseUrl": "https://api-inference.modelscope.cn/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "ZhipuAI/GLM-5.1",
        "label": "ZhipuAI/GLM-5.1"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://modelscope.cn",
    "apiKeyUrl": "https://modelscope.cn/my/myaccesstoken",
    "category": "aggregator"
  },
  {
    "id": "longcat",
    "label": "Longcat",
    "runtimeAgentId": "codex",
    "providerName": "longcat",
    "modelProvider": "longcat",
    "baseUrl": "https://api.longcat.chat/openai/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "LongCat-2.0",
        "label": "LongCat-2.0"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://longcat.chat/platform",
    "apiKeyUrl": "https://longcat.chat/platform/api_keys",
    "category": "cn_official"
  },
  {
    "id": "codex-minimax",
    "label": "MiniMax",
    "runtimeAgentId": "codex",
    "providerName": "minimax",
    "modelProvider": "minimax",
    "baseUrl": "https://api.minimaxi.com/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "MiniMax-M3",
        "label": "MiniMax-M3"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://platform.minimaxi.com",
    "apiKeyUrl": "https://platform.minimaxi.com/subscribe/coding-plan",
    "category": "cn_official"
  },
  {
    "id": "codex-bailing",
    "label": "BaiLing",
    "runtimeAgentId": "codex",
    "providerName": "bailing",
    "modelProvider": "bailing",
    "baseUrl": "https://api.tbox.cn/api/llm/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "Ling-2.6-1T",
        "label": "Ling-2.6-1T"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://alipaytbox.yuque.com/sxs0ba/ling/get_started",
    "apiKeyUrl": "https://ling.tbox.cn/open",
    "category": "cn_official"
  },
  {
    "id": "mimo",
    "label": "Xiaomi MiMo",
    "runtimeAgentId": "codex",
    "providerName": "xiaomi_mimo",
    "modelProvider": "xiaomi-mimo",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "mimo-v2.5-pro",
        "label": "mimo-v2.5-pro"
      },
      {
        "id": "mimo-v2.5",
        "label": "mimo-v2.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://platform.xiaomimimo.com",
    "apiKeyUrl": "https://platform.xiaomimimo.com/#/console/api-keys",
    "category": "cn_official"
  },
  {
    "id": "codex-siliconflow",
    "label": "SiliconFlow",
    "runtimeAgentId": "codex",
    "providerName": "siliconflow",
    "modelProvider": "siliconflow",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "Pro/MiniMaxAI/MiniMax-M2.7",
        "label": "Pro/MiniMaxAI/MiniMax-M2.7"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://siliconflow.cn",
    "apiKeyUrl": "https://cloud.siliconflow.cn/i/YflgU2Ve",
    "category": "aggregator"
  },
  {
    "id": "codex-novita-ai",
    "label": "Novita AI",
    "runtimeAgentId": "codex",
    "providerName": "novita",
    "modelProvider": "novita",
    "baseUrl": "https://api.novita.ai/openai/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "zai-org/glm-5.1",
        "label": "zai-org/glm-5.1"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://novita.ai",
    "apiKeyUrl": "https://novita.ai",
    "category": "aggregator"
  },
  {
    "id": "codex-nvidia",
    "label": "Nvidia",
    "runtimeAgentId": "codex",
    "providerName": "nvidia",
    "modelProvider": "nvidia",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "moonshotai/kimi-k2.5",
        "label": "moonshotai/kimi-k2.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://build.nvidia.com",
    "apiKeyUrl": "https://build.nvidia.com/settings/api-keys",
    "category": "aggregator"
  },
  {
    "id": "codex-opencode-go",
    "label": "OpenCode Go",
    "runtimeAgentId": "codex",
    "providerName": "opencode_go",
    "modelProvider": "opencode-go",
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "wireApi": "responses",
    "apiFormat": "openai_chat",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "glm-5.2",
        "label": "glm-5.2"
      },
      {
        "id": "glm-5.1",
        "label": "glm-5.1"
      },
      {
        "id": "kimi-k2.7-code",
        "label": "kimi-k2.7-code"
      },
      {
        "id": "deepseek-v4-pro",
        "label": "deepseek-v4-pro"
      },
      {
        "id": "deepseek-v4-flash",
        "label": "deepseek-v4-flash"
      },
      {
        "id": "mimo-v2.5-pro",
        "label": "mimo-v2.5-pro"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://opencode.ai/go",
    "apiKeyUrl": "https://opencode.ai/go?ref=2YTRG2NGTX",
    "category": "third_party"
  },
  {
    "id": "codex-aihubmix",
    "label": "AiHubMix",
    "runtimeAgentId": "codex",
    "providerName": "aihubmix",
    "modelProvider": "aihubmix",
    "baseUrl": "https://aihubmix.com/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.5",
        "label": "gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://aihubmix.com",
    "category": "aggregator"
  },
  {
    "id": "codex-packycode",
    "label": "PackyCode",
    "runtimeAgentId": "codex",
    "providerName": "packycode",
    "modelProvider": "packycode",
    "baseUrl": "https://www.packyapi.com/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.5",
        "label": "gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://www.packyapi.com",
    "apiKeyUrl": "https://www.packyapi.com/register?aff=cc-switch",
    "category": "third_party"
  },
  {
    "id": "codex-openrouter",
    "label": "OpenRouter",
    "runtimeAgentId": "codex",
    "providerName": "openrouter",
    "modelProvider": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "wireApi": "responses",
    "apiFormat": "openai_responses",
    "modelReasoningEffort": "high",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "gpt-5.5",
        "label": "gpt-5.5"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://openrouter.ai",
    "apiKeyUrl": "https://openrouter.ai/keys",
    "category": "aggregator"
  },
  {
    "id": "claude-code",
    "label": "Claude Official",
    "runtimeAgentId": "claude",
    "providerName": "Claude Official",
    "modelProvider": "claude-official-anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": false,
    "websiteUrl": "https://www.anthropic.com/claude-code",
    "category": "official"
  },
  {
    "id": "claude-code-shengsuanyun",
    "label": "Shengsuanyun",
    "runtimeAgentId": "claude",
    "providerName": "Shengsuanyun",
    "modelProvider": "shengsuanyun-anthropic",
    "baseUrl": "https://router.shengsuanyun.com/api",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "anthropic/claude-sonnet-5",
        "label": "anthropic/claude-sonnet-5"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "anthropic/claude-sonnet-5",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "anthropic/claude-sonnet-5",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic/claude-opus-4.8"
    },
    "websiteUrl": "https://www.shengsuanyun.com/?from=CH_4HHXMRYF",
    "apiKeyUrl": "https://www.shengsuanyun.com/?from=CH_4HHXMRYF",
    "category": "aggregator"
  },
  {
    "id": "claude-code-patewayai",
    "label": "PatewayAI",
    "runtimeAgentId": "claude",
    "providerName": "PatewayAI",
    "modelProvider": "patewayai-anthropic",
    "baseUrl": "https://api.pateway.ai",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_API_KEY",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://pateway.ai",
    "apiKeyUrl": "https://pateway.ai/?ch=etzpm8&aff=WB6M6F67#/",
    "category": "third_party"
  },
  {
    "id": "claude-code-agentplan",
    "label": "火山Agentplan",
    "runtimeAgentId": "claude",
    "providerName": "火山Agentplan",
    "modelProvider": "agentplan-anthropic",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "ark-code-latest",
        "label": "ark-code-latest"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "ark-code-latest",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "ark-code-latest",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "ark-code-latest",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "ark-code-latest"
    },
    "websiteUrl": "https://www.volcengine.com/activity/codingplan?ac=MMAP8JTTCAQ2&rc=6J6FV5N2&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "apiKeyUrl": "https://www.volcengine.com/activity/codingplan?ac=MMAP8JTTCAQ2&rc=6J6FV5N2&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "category": "cn_official"
  },
  {
    "id": "claude-code-byteplus",
    "label": "BytePlus",
    "runtimeAgentId": "claude",
    "providerName": "BytePlus",
    "modelProvider": "byteplus-anthropic",
    "baseUrl": "https://ark.ap-southeast.bytepluses.com/api/coding",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "ark-code-latest",
        "label": "ark-code-latest"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "ark-code-latest",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "ark-code-latest",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "ark-code-latest",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "ark-code-latest"
    },
    "websiteUrl": "https://www.byteplus.com/en/product/modelark?utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "apiKeyUrl": "https://www.byteplus.com/en/product/modelark?utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "category": "cn_official"
  },
  {
    "id": "claude-code-volcengine",
    "label": "DouBaoSeed",
    "runtimeAgentId": "claude",
    "providerName": "DouBaoSeed",
    "modelProvider": "doubaoseed-anthropic",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/compatible",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "doubao-seed-2-1-pro-260628",
        "label": "doubao-seed-2-1-pro-260628"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "API_TIMEOUT_MS": "3000000",
      "ANTHROPIC_MODEL": "doubao-seed-2-1-pro-260628",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "doubao-seed-2-1-pro-260628",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "doubao-seed-2-1-pro-260628",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "doubao-seed-2-1-pro-260628"
    },
    "websiteUrl": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?apikey=%7B%7D&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "apiKeyUrl": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?apikey=%7B%7D&utm_campaign=hw&utm_content=ccswitch&utm_medium=devrel_tool_web&utm_source=OWO&utm_term=ccswitch",
    "category": "cn_official"
  },
  {
    "id": "claude-code-qiniu",
    "label": "Qiniu",
    "runtimeAgentId": "claude",
    "providerName": "Qiniu",
    "modelProvider": "qiniu-anthropic",
    "baseUrl": "https://api.qnaigc.com",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://s.qiniu.com/nMvAvy",
    "apiKeyUrl": "https://s.qiniu.com/nMvAvy",
    "category": "aggregator"
  },
  {
    "id": "claude-code-deepseek",
    "label": "DeepSeek",
    "runtimeAgentId": "claude",
    "providerName": "DeepSeek",
    "modelProvider": "deepseek-anthropic",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "deepseek-v4-pro",
        "label": "deepseek-v4-pro"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "deepseek-v4-pro",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro"
    },
    "websiteUrl": "https://platform.deepseek.com",
    "category": "cn_official"
  },
  {
    "id": "claude-code-glm",
    "label": "Zhipu GLM",
    "runtimeAgentId": "claude",
    "providerName": "Zhipu GLM",
    "modelProvider": "zhipu-glm-anthropic",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "glm-5.1",
        "label": "glm-5.1"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "glm-5.1",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.1",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1"
    },
    "websiteUrl": "https://open.bigmodel.cn",
    "apiKeyUrl": "https://www.bigmodel.cn/claude-code?ic=RRVJPB5SII",
    "category": "cn_official"
  },
  {
    "id": "claude-code-baidu-qianfan-coding-plan",
    "label": "Baidu Qianfan Coding Plan",
    "runtimeAgentId": "claude",
    "providerName": "Baidu Qianfan Coding Plan",
    "modelProvider": "baidu-qianfan-coding-plan-anthropic",
    "baseUrl": "https://qianfan.baidubce.com/anthropic/coding",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "qianfan-code-latest",
        "label": "qianfan-code-latest"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "qianfan-code-latest",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qianfan-code-latest",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "qianfan-code-latest",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "qianfan-code-latest"
    },
    "websiteUrl": "https://cloud.baidu.com/product/qianfan_modelbuilder",
    "apiKeyUrl": "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    "category": "cn_official"
  },
  {
    "id": "claude-code-bailian",
    "label": "Bailian",
    "runtimeAgentId": "claude",
    "providerName": "Bailian",
    "modelProvider": "bailian-anthropic",
    "baseUrl": "https://dashscope.aliyuncs.com/apps/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://bailian.console.aliyun.com",
    "category": "cn_official"
  },
  {
    "id": "claude-code-bailian-for-coding",
    "label": "Bailian For Coding",
    "runtimeAgentId": "claude",
    "providerName": "Bailian For Coding",
    "modelProvider": "bailian-for-coding-anthropic",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://bailian.console.aliyun.com",
    "category": "cn_official"
  },
  {
    "id": "claude-code-kimi",
    "label": "Kimi",
    "runtimeAgentId": "claude",
    "providerName": "Kimi",
    "modelProvider": "kimi-anthropic",
    "baseUrl": "https://api.moonshot.cn/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "kimi-k2.7-code",
        "label": "kimi-k2.7-code"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "kimi-k2.7-code",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-k2.7-code",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2.7-code",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-k2.7-code"
    },
    "websiteUrl": "https://platform.kimi.com?aff=cc-switch",
    "category": "cn_official"
  },
  {
    "id": "claude-code-kimi-for-coding",
    "label": "Kimi For Coding",
    "runtimeAgentId": "claude",
    "providerName": "Kimi For Coding",
    "modelProvider": "kimi-for-coding-anthropic",
    "baseUrl": "https://api.kimi.com/coding/",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "${CLAUDE_CODE_AUTO_COMPACT_WINDOW}"
    },
    "websiteUrl": "https://www.kimi.com/code/?aff=cc-switch",
    "category": "cn_official"
  },
  {
    "id": "claude-code-stepfun",
    "label": "StepFun",
    "runtimeAgentId": "claude",
    "providerName": "StepFun",
    "modelProvider": "stepfun-anthropic",
    "baseUrl": "https://api.stepfun.com/step_plan",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "step-3.5-flash-2603",
        "label": "step-3.5-flash-2603"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "step-3.5-flash-2603",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "step-3.5-flash-2603",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "step-3.5-flash-2603",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "step-3.5-flash-2603"
    },
    "websiteUrl": "https://platform.stepfun.com/step-plan",
    "apiKeyUrl": "https://platform.stepfun.com/interface-key",
    "category": "cn_official"
  },
  {
    "id": "claude-code-modelscope",
    "label": "ModelScope",
    "runtimeAgentId": "claude",
    "providerName": "ModelScope",
    "modelProvider": "modelscope-anthropic",
    "baseUrl": "https://api-inference.modelscope.cn",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "ZhipuAI/GLM-5.1",
        "label": "ZhipuAI/GLM-5.1"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "ZhipuAI/GLM-5.1",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "ZhipuAI/GLM-5.1",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "ZhipuAI/GLM-5.1",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "ZhipuAI/GLM-5.1"
    },
    "websiteUrl": "https://modelscope.cn",
    "category": "aggregator"
  },
  {
    "id": "claude-code-longcat",
    "label": "Longcat",
    "runtimeAgentId": "claude",
    "providerName": "Longcat",
    "modelProvider": "longcat-anthropic",
    "baseUrl": "https://api.longcat.chat/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "LongCat-2.0",
        "label": "LongCat-2.0"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "LongCat-2.0",
      "ANTHROPIC_SMALL_FAST_MODEL": "LongCat-2.0",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "LongCat-2.0",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "LongCat-2.0",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "LongCat-2.0",
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    },
    "websiteUrl": "https://longcat.chat/platform",
    "apiKeyUrl": "https://longcat.chat/platform/api_keys",
    "category": "cn_official"
  },
  {
    "id": "claude-code-minimax",
    "label": "MiniMax",
    "runtimeAgentId": "claude",
    "providerName": "MiniMax",
    "modelProvider": "minimax-anthropic",
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "MiniMax-M2.7",
        "label": "MiniMax-M2.7"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "API_TIMEOUT_MS": "3000000",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
      "ANTHROPIC_MODEL": "MiniMax-M2.7",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2.7",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M2.7",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2.7"
    },
    "websiteUrl": "https://platform.minimaxi.com",
    "apiKeyUrl": "https://platform.minimaxi.com/subscribe/coding-plan",
    "category": "cn_official"
  },
  {
    "id": "claude-code-bailing",
    "label": "BaiLing",
    "runtimeAgentId": "claude",
    "providerName": "BaiLing",
    "modelProvider": "bailing-anthropic",
    "baseUrl": "https://api.tbox.cn/api/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "Ling-2.5-1T",
        "label": "Ling-2.5-1T"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "Ling-2.5-1T",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "Ling-2.5-1T",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "Ling-2.5-1T",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "Ling-2.5-1T"
    },
    "websiteUrl": "https://alipaytbox.yuque.com/sxs0ba/ling/get_started",
    "category": "cn_official"
  },
  {
    "id": "claude-code-siliconflow",
    "label": "SiliconFlow",
    "runtimeAgentId": "claude",
    "providerName": "SiliconFlow",
    "modelProvider": "siliconflow-anthropic",
    "baseUrl": "https://api.siliconflow.cn",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "Pro/MiniMaxAI/MiniMax-M2.7",
        "label": "Pro/MiniMaxAI/MiniMax-M2.7"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "Pro/MiniMaxAI/MiniMax-M2.7",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "Pro/MiniMaxAI/MiniMax-M2.7",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "Pro/MiniMaxAI/MiniMax-M2.7",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "Pro/MiniMaxAI/MiniMax-M2.7"
    },
    "websiteUrl": "https://siliconflow.cn",
    "apiKeyUrl": "https://cloud.siliconflow.cn/i/YflgU2Ve",
    "category": "aggregator"
  },
  {
    "id": "claude-code-packycode",
    "label": "PackyCode",
    "runtimeAgentId": "claude",
    "providerName": "PackyCode",
    "modelProvider": "packycode-anthropic",
    "baseUrl": "https://www.packyapi.com",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      }
    ],
    "usesApiKey": true,
    "websiteUrl": "https://www.packyapi.com",
    "apiKeyUrl": "https://www.packyapi.com/register?aff=cc-switch",
    "category": "third_party"
  },
  {
    "id": "claude-code-openrouter",
    "label": "OpenRouter",
    "runtimeAgentId": "claude",
    "providerName": "OpenRouter",
    "modelProvider": "openrouter-anthropic",
    "baseUrl": "https://openrouter.ai/api",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "anthropic/claude-sonnet-5",
        "label": "anthropic/claude-sonnet-5"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "anthropic/claude-sonnet-5",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "anthropic/claude-sonnet-5",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic/claude-opus-4.8"
    },
    "websiteUrl": "https://openrouter.ai",
    "apiKeyUrl": "https://openrouter.ai/keys",
    "category": "aggregator"
  },
  {
    "id": "claude-code-novita-ai",
    "label": "Novita AI",
    "runtimeAgentId": "claude",
    "providerName": "Novita AI",
    "modelProvider": "novita-ai-anthropic",
    "baseUrl": "https://api.novita.ai/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "zai-org/glm-5.1",
        "label": "zai-org/glm-5.1"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "zai-org/glm-5.1",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "zai-org/glm-5.1",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "zai-org/glm-5.1",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "zai-org/glm-5.1"
    },
    "websiteUrl": "https://novita.ai",
    "apiKeyUrl": "https://novita.ai",
    "category": "aggregator"
  },
  {
    "id": "claude-code-xiaomi-mimo",
    "label": "Xiaomi MiMo",
    "runtimeAgentId": "claude",
    "providerName": "Xiaomi MiMo",
    "modelProvider": "xiaomi-mimo-anthropic",
    "baseUrl": "https://api.xiaomimimo.com/anthropic",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "mimo-v2.5-pro",
        "label": "mimo-v2.5-pro"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "ANTHROPIC_MODEL": "mimo-v2.5-pro",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "mimo-v2.5-pro",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "mimo-v2.5-pro",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "mimo-v2.5-pro"
    },
    "websiteUrl": "https://platform.xiaomimimo.com",
    "apiKeyUrl": "https://platform.xiaomimimo.com/#/console/api-keys",
    "category": "cn_official"
  },
  {
    "id": "claude-code-aws-bedrock-api-key",
    "label": "AWS Bedrock (API Key)",
    "runtimeAgentId": "claude",
    "providerName": "AWS Bedrock (API Key)",
    "modelProvider": "aws-bedrock-api-key-anthropic",
    "baseUrl": "https://bedrock-runtime.${AWS_REGION}.amazonaws.com",
    "apiFormat": "anthropic",
    "apiKeyField": "ANTHROPIC_AUTH_TOKEN",
    "models": [
      {
        "id": "default",
        "label": "Default"
      },
      {
        "id": "global.anthropic.claude-opus-4-8",
        "label": "global.anthropic.claude-opus-4-8"
      }
    ],
    "usesApiKey": true,
    "environment": {
      "AWS_REGION": "${AWS_REGION}",
      "ANTHROPIC_MODEL": "global.anthropic.claude-opus-4-8",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "global.anthropic.claude-sonnet-5",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "global.anthropic.claude-opus-4-8",
      "CLAUDE_CODE_USE_BEDROCK": "1"
    },
    "websiteUrl": "https://aws.amazon.com/bedrock/",
    "category": "cloud_provider"
  }
];
