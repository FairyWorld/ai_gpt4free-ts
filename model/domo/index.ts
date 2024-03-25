import { Chat, ChatOptions, ChatRequest, ModelType, Site } from '../base';
import { Pool } from '../../utils/pool';
import { Child } from './child';
import {
  Account,
  AIAction,
  AIActionType,
  ComponentLabelMap,
  DomoSpeedMode,
  getProgress,
} from './define';
import { Config } from '../../utils/config';
import { v4 } from 'uuid';
import {
  ComError,
  downloadAndUploadCDN,
  Event,
  EventStream,
  extractJSON,
  MessageData,
  ThroughEventStream,
} from '../../utils';
import { chatModel } from '../index';
import { clearInterval } from 'timers';
import { MJPrompt } from './prompt';
import {
  GatewayDMessageCreate,
  getAllComponents,
  MessageFlags,
} from '../discord/define';
import Application from 'koa';
import { CreateVideoTaskRequest } from '../define';

export class Domo extends Chat {
  private pool = new Pool<Account, Child>(
    this.options?.name || '',
    () => Config.config.domo.size,
    (info, options) => {
      return new Child(this.options?.name || '', info, options);
    },
    (info) => {
      if (!info.token) {
        return false;
      }
      if (!info.server_id) {
        return false;
      }
      if (!info.channel_id) {
        return false;
      }
      if (
        info.mode !== DomoSpeedMode.Relax &&
        info.profile &&
        info.profile.paidCreditsBalance === 0
      ) {
        return false;
      }
      return true;
    },
    {
      delay: 3000,
      serial: () => Config.config.domo.serial,
      preHandleAllInfos: async (allInfos) => {
        const channelIDSet = new Set(allInfos.map((v) => v.channel_id));
        const result: Account[] = allInfos;
        for (const info of Config.config.domo.accounts) {
          if (channelIDSet.has(info.channel_id)) {
            Object.assign(
              info,
              allInfos.find((v) => v.channel_id === info.channel_id),
            );
            continue;
          }
          result.push({
            id: v4(),
            token: info.token,
            server_id: info.server_id,
            channel_id: info.channel_id,
            mode: info.mode || DomoSpeedMode.Fast,
          } as Account);
        }
        return result;
      },
    },
  );

  constructor(options?: ChatOptions) {
    super(options);
  }

  support(model: ModelType): number {
    switch (model) {
      case ModelType.DomoChatGen:
        return 28000;
      case ModelType.DomoChatAnimate:
        return 28000;
      default:
        return 0;
    }
  }

  async handleComponents(
    e: GatewayDMessageCreate,
    child: Child,
    stream: EventStream,
  ) {
    const components = getAllComponents(e.components);
    // const urls = await this.doMultiComponents(
    //   child,
    //   e.id,
    //   components
    //     .filter((v) => v.label?.startsWith('U') || false)
    //     .map((v) => v.custom_id),
    // );
    // stream.write(Event.message, {
    //   content:
    //     urls.map((v, idx) => `[下载${idx + 1}](${v})`).join(' ') + '\n\n',
    // });
    if (components?.length) {
      stream.write(Event.message, {
        content: `|name|label|type|custom_id|\n|---|---|---|---|\n`,
      });
      for (const b of components) {
        // if (b.label?.startsWith('U')) {
        //   continue;
        // }
        const label = b.label || b.emoji?.name;
        if (b.type === 2 && label && ComponentLabelMap[label]) {
          b.name = ComponentLabelMap[label];
          stream.write(Event.message, {
            content: `|${b.name}${b.style === 3 ? '☑️' : ''}|${label}|${
              b.type
            }|${b.custom_id}|\n`,
          });
        }
      }
    }
  }

  async gen(
    action: AIAction,
    child: Child,
    stream: EventStream,
    onEnd: () => void,
  ) {
    let itl: NodeJS.Timeout;
    await child.gen(action.prompt!, {
      model: action.model,
      image_url: action.image_url,
      onStart: (e) => {
        stream.write(Event.message, { content: '> 开始绘制' });
        itl = setInterval(() => {
          stream.write(Event.message, { content: `.` });
        }, 3000);
      },
      onEnd: async (e) => {
        clearInterval(itl);
        const url = await downloadAndUploadCDN(e.attachments[0]?.url);
        stream.write(Event.message, {
          content: `[100%](${url})\n\n`,
        });
        stream.write(Event.message, {
          content: `![${action.prompt}](${url})\n[⏬下载](${url.replace(
            '/cdn/',
            '/cdn/download/',
          )})\n\n`,
        });
        stream.write(Event.message, {
          content: `> reference_prompt: ${action.prompt}\n\n`,
        });
        await this.handleComponents(e, child, stream);
        stream.write(Event.message, {
          content: '\n **接下来你可以直接对我说命令，例如：帮我放大第一张图**',
        });
        stream.write(Event.done, { content: '' });
        stream.end();
        onEnd();
      },
      onError: (e) => {
        clearInterval(itl);
        stream.write(Event.message, {
          content: e.message,
        });
        stream.write(Event.done, { content: '' });
        stream.end();
        onEnd();
      },
    });
  }

  async askStream(req: ChatRequest, stream: EventStream): Promise<void> {
    const child = await this.pool.pop();
    try {
      const auto = chatModel.get(Site.Auto);
      let old = '';
      const pt = new ThroughEventStream(
        (event, data) => {
          stream.write(event, data);
          if ((data as MessageData).content) {
            old += (data as MessageData).content;
          }
        },
        async () => {
          try {
            stream.write(Event.message, { content: '\n\n' });
            const action = extractJSON<AIAction>(old);
            if (!action) {
              stream.write(Event.message, {
                content: 'Generate action failed',
              });
              stream.write(Event.done, { content: '' });
              stream.end();
              return;
            }
            switch (action?.type) {
              // case AIActionType.Imagine:
              //   this.logger.info(child.info.channel_id);
              //   await this.imagine(action, child, stream, () =>
              //     child.release(),
              //   );
              //   return;
              case AIActionType.Component:
                try {
                  const newChild = await this.pool.popIf(
                    (v) => v.channel_id === action.channel_id,
                  );
                } catch (e) {
                  stream.write(Event.message, {
                    content: '该图像处理服务器已掉线',
                  });
                  stream.write(Event.done, { content: '' });
                  stream.end();
                }
                return;
              case AIActionType.Gen:
                await this.gen(action, child, stream, () => child.release());
                return;
              case AIActionType.Animate:
                return;
              default:
                stream.write(Event.done, { content: '' });
                stream.end();
                child.release();
                break;
            }
          } catch (e: any) {
            stream.write(Event.error, { error: e.message });
            stream.write(Event.done, { content: '' });
            stream.end();
          }
        },
      );
      await auto?.askStream(
        {
          ...req,
          messages: [{ role: 'system', content: MJPrompt }, ...req.messages],
          model: ModelType.GPT4_32k,
        } as ChatRequest,
        pt,
      );
    } catch (e: any) {
      child.release();
      throw new ComError(e.message);
    }
  }

  async createVideoTask(
    ctx: Application.Context,
    req: CreateVideoTaskRequest,
  ): Promise<void> {
    const child = await this.pool.pop();
    ctx.body = await child.createVideo({ image_url: req.image });
  }
}
