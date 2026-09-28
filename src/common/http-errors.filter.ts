import { Catch, ArgumentsHost, ExceptionFilter, HttpException } from "@nestjs/common";
import { ZodError } from "zod";
@Catch()
export class Errors implements ExceptionFilter {
    catch(e: any, host: ArgumentsHost) {
        const status = e instanceof ZodError
            ? 400
            : e instanceof HttpException
                ? e.getStatus()
                : 500;
        host
            .switchToHttp()
            .getResponse()
            .status(status)
            .json({
            message: e instanceof ZodError
                ? e.issues.map((x) => x.message).join("; ")
                : status < 500
                    ? e.message
                    : "Không thể xử lý yêu cầu. Kiểm tra kết nối dịch vụ.",
        });
        if (status === 500)
            console.error(e.name, e.code || "internal");
    }
}
