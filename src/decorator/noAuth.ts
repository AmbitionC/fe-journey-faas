import {
  IMidwayContainer,
  MidwayWebRouterService,
  Singleton,
} from '@midwayjs/core';
import {
  ApplicationContext,
  attachClassMetadata,
  Autoload,
  getClassMetadata,
  Init,
  Inject,
  listModule,
  CONTROLLER_KEY,
} from '@midwayjs/decorator';

// 提供一个唯一 key
export const NO_AUTH_KEY = 'decorator:noAuth';

export function NoAuth(): MethodDecorator {
  return (target, key, descriptor: PropertyDescriptor) => {
    attachClassMetadata(NO_AUTH_KEY, { methodName: key }, target);
    return descriptor;
  };
}

@Autoload()
@Singleton()
export class NoAuthDecorator {
  @Inject()
  webRouterService: MidwayWebRouterService;
  @ApplicationContext()
  applicationContext: IMidwayContainer;

  @Init()
  async init() {
    const controllerModules = listModule(CONTROLLER_KEY);
    const whiteMethods = [];
    for (const module of controllerModules) {
      const methodNames = getClassMetadata(NO_AUTH_KEY, module) || [];
      const className = module.name[0].toLowerCase() + module.name.slice(1);
      whiteMethods.push(
        ...methodNames.map(method => `${className}.${method.methodName}`)
      );
    }

    const routerTables = await this.webRouterService.getFlattenRouterTable();
    const whiteRouters = routerTables.filter(router =>
      whiteMethods.includes(router.handlerName)
    );

    this.applicationContext.registerObject('noAuthRouters', whiteRouters);
  }
}
