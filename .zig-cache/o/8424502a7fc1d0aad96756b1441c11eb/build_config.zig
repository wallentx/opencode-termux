const config = @import("config.zig");
const config_x = @import("config.x.zig");
const d = config.default;

pub const tables = [_]config.Table{
    .{
        .extensions = &.{
        },
        .fields = &config._resolveFields(
            config_x,
            &.{
                "grapheme_break",
                "east_asian_width",
                "general_category",
                "is_emoji_presentation",
            },
            &.{
            },
        ),
     },
};
